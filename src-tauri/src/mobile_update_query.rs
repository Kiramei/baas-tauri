//! Keep Android update I/O off the WebView IPC thread without multiplying timed-out work.

use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant};
use tokio::sync::watch;

type QueryResult = Result<Value, String>;

/// SourceSelector normally detaches losing mirror probes. Keep those probes inside this flight's
/// lifetime too, so a quick winner cannot allow a second check to accumulate more network workers.
pub(crate) struct QueryProbeScope(Arc<ProbeWorkers>);

struct ProbeWorkers {
    count: Mutex<usize>,
    finished: Condvar,
}

pub(crate) struct QueryProbeLease(Arc<ProbeWorkers>);

impl QueryProbeScope {
    pub(crate) fn new() -> Self {
        Self(Arc::new(ProbeWorkers {
            count: Mutex::new(0),
            finished: Condvar::new(),
        }))
    }

    pub(crate) fn lease(&self) -> QueryProbeLease {
        *self
            .0
            .count
            .lock()
            .unwrap_or_else(|error| error.into_inner()) += 1;
        QueryProbeLease(Arc::clone(&self.0))
    }
}

impl Clone for QueryProbeLease {
    fn clone(&self) -> Self {
        *self
            .0
            .count
            .lock()
            .unwrap_or_else(|error| error.into_inner()) += 1;
        Self(Arc::clone(&self.0))
    }
}

impl Drop for QueryProbeLease {
    fn drop(&mut self) {
        let mut count = self
            .0
            .count
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *count -= 1;
        if *count == 0 {
            self.0.finished.notify_all();
        }
    }
}

impl Drop for QueryProbeScope {
    fn drop(&mut self) {
        let mut count = self
            .0
            .count
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while *count != 0 {
            count = self
                .0
                .finished
                .wait(count)
                .unwrap_or_else(|error| error.into_inner());
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct QueryDeadline {
    name: &'static str,
    expires: Instant,
}

impl QueryDeadline {
    /// A deadline is cooperative: it prevents another mirror attempt, but cannot kill git2 I/O.
    pub(crate) fn remaining(self) -> Result<Duration, String> {
        self.expires
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| {
                format!(
                    "{} exceeded its check budget; no further sources were tried",
                    self.name
                )
            })
    }
}

struct Flight {
    key: String,
    deadline: QueryDeadline,
    result: watch::Sender<Option<QueryResult>>,
    delivered: AtomicBool,
}

pub(crate) struct UpdateQuery {
    name: &'static str,
    current: Mutex<Option<Arc<Flight>>>,
}

impl UpdateQuery {
    pub(crate) const fn new(name: &'static str) -> Self {
        Self {
            name,
            current: Mutex::new(None),
        }
    }

    /// Waiters can time out or disappear, but only the worker's actual completion frees its slot.
    /// A late result is retained for one subsequent same-key check instead of being silently lost.
    pub(crate) async fn run<F>(&self, key: String, timeout: Duration, work: F) -> QueryResult
    where
        F: FnOnce(QueryDeadline) -> QueryResult + Send + 'static,
    {
        let (flight, start) = {
            // This lock only protects bookkeeping; no I/O or await occurs while it is held.
            let mut current = self
                .current
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let active = current.as_ref().filter(|flight| {
                flight.result.borrow().is_none()
                    || (!flight.delivered.load(Ordering::Acquire) && flight.key == key)
            });
            match active {
                Some(flight) if flight.key != key => {
                    return Err(format!(
                        "{} is still running for another request; retry after it finishes",
                        self.name
                    ));
                }
                Some(flight) => (Arc::clone(flight), false),
                None => {
                    let (result, _) = watch::channel(None);
                    let flight = Arc::new(Flight {
                        key,
                        deadline: QueryDeadline {
                            name: self.name,
                            expires: Instant::now() + timeout,
                        },
                        result,
                        delivered: AtomicBool::new(false),
                    });
                    *current = Some(Arc::clone(&flight));
                    (flight, true)
                }
            }
        };

        if start {
            let worker_flight = Arc::clone(&flight);
            // The supervisor outlives the command future, including frontend timeout/cancellation.
            tokio::spawn(async move {
                let deadline = worker_flight.deadline;
                let result = tokio::task::spawn_blocking(move || {
                    deadline.remaining()?;
                    work(deadline)
                })
                .await
                .unwrap_or_else(|error| Err(format!("{} worker failed: {error}", deadline.name)));
                // send_replace also stores the result when every original waiter has gone away.
                worker_flight.result.send_replace(Some(result));
            });
        }

        let mut receiver = flight.result.subscribe();
        let ready = receiver.borrow_and_update().clone();
        if let Some(result) = ready {
            flight.delivered.store(true, Ordering::Release);
            return result;
        }
        let wait = async {
            loop {
                receiver
                    .changed()
                    .await
                    .map_err(|_| format!("{} worker result channel closed", self.name))?;
                let ready = receiver.borrow_and_update().clone();
                if let Some(result) = ready {
                    return result;
                }
            }
        };
        // Joining an old flight never renews its time budget.
        let remaining = flight.deadline.remaining().unwrap_or_default();
        match tokio::time::timeout(remaining.min(timeout), wait).await {
            Ok(result) => {
                flight.delivered.store(true, Ordering::Release);
                result
            }
            Err(_) => Err(format!(
                "{} timed out waiting for the check; the network worker was not cancelled and retries will reuse it until it finishes",
                self.name
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{atomic::AtomicUsize, mpsc};

    const WAIT: Duration = Duration::from_secs(2);
    const SHORT_WAIT: Duration = Duration::from_millis(100);

    async fn result_ready(query: &UpdateQuery) {
        tokio::time::timeout(WAIT, async {
            loop {
                let ready = query
                    .current
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|flight| flight.result.borrow().is_some());
                if ready {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_network_work_does_not_block_the_async_ipc_executor() {
        let query = Arc::new(UpdateQuery::new("test check"));
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = mpsc::channel();
        let task_query = Arc::clone(&query);
        let task = tokio::spawn(async move {
            task_query
                .run("same".into(), WAIT, move |_| {
                    started.send(()).unwrap();
                    release_rx.recv_timeout(WAIT).unwrap();
                    Ok(json!("done"))
                })
                .await
        });
        started_rx.await.unwrap();
        // This timer runs on the only async executor thread while the network worker is blocked.
        tokio::time::sleep(Duration::from_millis(10)).await;
        release.send(()).unwrap();
        assert_eq!(task.await.unwrap(), Ok(json!("done")));
    }

    #[tokio::test]
    async fn concurrent_same_key_waiters_share_one_worker_and_its_result() {
        let query = Arc::new(UpdateQuery::new("test check"));
        let starts = Arc::new(AtomicUsize::new(0));
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = mpsc::channel();
        let first_query = Arc::clone(&query);
        let first_starts = Arc::clone(&starts);
        let first = tokio::spawn(async move {
            first_query
                .run("same".into(), WAIT, move |_| {
                    first_starts.fetch_add(1, Ordering::SeqCst);
                    started.send(()).unwrap();
                    release_rx.recv_timeout(WAIT).unwrap();
                    Ok(json!({"remote":"abc"}))
                })
                .await
        });
        started_rx.await.unwrap();
        let second_query = Arc::clone(&query);
        let second = tokio::spawn(async move {
            second_query
                .run("same".into(), WAIT, |_| panic!("duplicate worker"))
                .await
        });
        tokio::task::yield_now().await;
        release.send(()).unwrap();
        assert_eq!(first.await.unwrap(), Ok(json!({"remote":"abc"})));
        assert_eq!(second.await.unwrap(), Ok(json!({"remote":"abc"})));
        assert_eq!(starts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn timeout_keeps_single_flight_and_preserves_late_result_then_allows_fresh_work() {
        let query = UpdateQuery::new("test check");
        let (release, release_rx) = mpsc::channel();
        let first = query
            .run("same".into(), SHORT_WAIT, move |_| {
                release_rx.recv_timeout(WAIT).unwrap();
                Ok(json!("late result"))
            })
            .await
            .unwrap_err();
        assert!(first.contains("not cancelled"));
        let retry = query
            .run("same".into(), WAIT, |_| {
                panic!("timed out flight restarted")
            })
            .await;
        assert!(retry.unwrap_err().contains("not cancelled"));
        release.send(()).unwrap();
        result_ready(&query).await;
        assert_eq!(
            query
                .run("same".into(), WAIT, |_| panic!("late result lost"))
                .await,
            Ok(json!("late result"))
        );
        assert_eq!(
            query.run("same".into(), WAIT, |_| Ok(json!("fresh"))).await,
            Ok(json!("fresh"))
        );
    }

    #[tokio::test]
    async fn normal_error_does_not_permanently_lock_out_the_next_check() {
        let query = UpdateQuery::new("test check");
        assert_eq!(
            query
                .run("same".into(), WAIT, |_| Err("offline".into()))
                .await,
            Err("offline".into())
        );
        assert_eq!(
            query
                .run("same".into(), WAIT, |_| Ok(json!("online")))
                .await,
            Ok(json!("online"))
        );
    }

    #[tokio::test]
    async fn panicked_worker_reports_error_and_allows_recovery() {
        let query = UpdateQuery::new("test check");
        let error = query
            .run("same".into(), WAIT, |_| panic!("network panic"))
            .await
            .unwrap_err();
        assert!(error.contains("worker failed"));
        assert_eq!(
            query.run("same".into(), WAIT, |_| Ok(json!(true))).await,
            Ok(json!(true))
        );
    }

    #[tokio::test]
    async fn cancelled_command_does_not_abandon_or_duplicate_its_worker() {
        let query = Arc::new(UpdateQuery::new("test check"));
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = mpsc::channel();
        let first_query = Arc::clone(&query);
        let first = tokio::spawn(async move {
            first_query
                .run("same".into(), WAIT, move |_| {
                    started.send(()).unwrap();
                    release_rx.recv_timeout(WAIT).unwrap();
                    Ok(json!("retained"))
                })
                .await
        });
        started_rx.await.unwrap();
        first.abort();
        let _ = first.await;
        release.send(()).unwrap();
        result_ready(&query).await;
        assert_eq!(
            query
                .run("same".into(), WAIT, |_| panic!(
                    "cancelled caller lost worker"
                ))
                .await,
            Ok(json!("retained"))
        );
    }

    #[tokio::test]
    async fn different_request_cannot_join_the_wrong_result_or_start_parallel_work() {
        let query = Arc::new(UpdateQuery::new("test check"));
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = mpsc::channel();
        let first_query = Arc::clone(&query);
        let first = tokio::spawn(async move {
            first_query
                .run("dev".into(), WAIT, move |_| {
                    started.send(()).unwrap();
                    release_rx.recv_timeout(WAIT).unwrap();
                    Ok(json!("dev"))
                })
                .await
        });
        started_rx.await.unwrap();
        let error = query
            .run("stable".into(), WAIT, |_| panic!("parallel request"))
            .await
            .unwrap_err();
        assert!(error.contains("another request"));
        release.send(()).unwrap();
        assert_eq!(first.await.unwrap(), Ok(json!("dev")));
        assert_eq!(
            query
                .run("stable".into(), WAIT, |_| Ok(json!("stable")))
                .await,
            Ok(json!("stable"))
        );
    }

    #[tokio::test]
    async fn deadline_stops_new_attempts_but_does_not_claim_to_cancel_running_io() {
        let query = UpdateQuery::new("test check");
        let (release, release_rx) = mpsc::channel();
        assert!(query
            .run("same".into(), SHORT_WAIT, move |deadline| {
                assert!(deadline.remaining().is_ok());
                release_rx.recv_timeout(WAIT).unwrap();
                deadline.remaining()?;
                panic!("a new mirror must not start after the budget expires")
            })
            .await
            .is_err());
        release.send(()).unwrap();
        result_ready(&query).await;
        let error = query
            .run("same".into(), WAIT, |_| panic!("lost deadline error"))
            .await
            .unwrap_err();
        assert!(error.contains("no further sources"));
    }

    #[tokio::test]
    async fn detached_mirror_probe_remains_part_of_single_flight_after_a_quick_winner() {
        let query = UpdateQuery::new("test check");
        let (release, release_rx) = mpsc::channel();
        assert!(query
            .run("same".into(), SHORT_WAIT, move |_| {
                let scope = QueryProbeScope::new();
                let primary = scope.lease();
                let child = primary.clone();
                std::thread::spawn(move || {
                    let _lease = child;
                    release_rx.recv_timeout(WAIT).unwrap();
                });
                drop(primary);
                // Dropping the scope waits for the losing probe, even though the winner is ready.
                Ok(json!("winner"))
            })
            .await
            .is_err());
        assert!(query
            .run("same".into(), WAIT, |_| panic!("losing probe duplicated"))
            .await
            .is_err());
        release.send(()).unwrap();
        result_ready(&query).await;
        assert_eq!(
            query
                .run("same".into(), WAIT, |_| panic!("winner result lost"))
                .await,
            Ok(json!("winner"))
        );
    }
}
