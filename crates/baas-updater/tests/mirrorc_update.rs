use baas_updater::{
    NoopOutput, OutputSink, RepositoryKind, UpdateChannel, UpdateStatus, UpdaterResult,
    mirrorc::{MirrorCClient, MirrorHttp, MirrorUpdateRequest},
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    fs,
    io::{Cursor, Write},
    time::Duration,
};

struct Packages {
    responses: RefCell<VecDeque<Value>>,
    packages: RefCell<VecDeque<Vec<u8>>>,
    downloads: Cell<usize>,
}

impl MirrorHttp for Packages {
    fn get_json(&self, _: &str, _: Duration) -> UpdaterResult<Value> {
        Ok(self
            .responses
            .borrow_mut()
            .pop_front()
            .expect("Unexpected extra API request"))
    }
    fn download(
        &self,
        _: &str,
        _: Duration,
        _: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<Vec<u8>> {
        self.downloads.set(self.downloads.get() + 1);
        Ok(self
            .packages
            .borrow_mut()
            .pop_front()
            .expect("Unexpected package download"))
    }
}

impl MirrorHttp for &Packages {
    fn get_json(&self, url: &str, timeout: Duration) -> UpdaterResult<Value> {
        (**self).get_json(url, timeout)
    }
    fn download(
        &self,
        url: &str,
        timeout: Duration,
        output: &(impl OutputSink + ?Sized),
    ) -> UpdaterResult<Vec<u8>> {
        (**self).download(url, timeout, output)
    }
}

fn zip_files(files: &[(&str, &str)]) -> Vec<u8> {
    let mut buffer = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buffer);
        for (path, content) in files {
            zip.start_file(*path, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }
    buffer.into_inner()
}

#[test]
fn full_then_incremental_then_current_version_preserves_local_configuration() {
    let target = tempfile::tempdir().unwrap();
    fs::create_dir(target.path().join("config")).unwrap();
    let local_config = target.path().join("config/profile.json");
    fs::write(&local_config, "local profile stays unchanged").unwrap();
    let http = Packages {
        responses: RefCell::new(VecDeque::from([
            json!({"code":0,"msg":"ok","data":{"version_name":"v1","url":"https://test.invalid/full","update_type":"full"}}),
            json!({"code":0,"msg":"ok","data":{"version_name":"v2","url":"https://test.invalid/delta","update_type":"incremental"}}),
            json!({"code":0,"msg":"ok","data":{"version_name":"v2"}}),
        ])),
        packages: RefCell::new(VecDeque::from([
            zip_files(&[
                ("repo/main.py", "version one"),
                ("repo/obsolete.txt", "old"),
                ("repo/unchanged.txt", "keep"),
            ]),
            zip_files(&[
                (
                    "changes.json",
                    r#"{"added":["repo/new.txt"],"modified":["repo/main.py"],"deleted":["repo/obsolete.txt"]}"#,
                ),
                ("repo/main.py", "version two"),
                ("repo/new.txt", "new"),
            ]),
        ])),
        downloads: Cell::new(0),
    };
    let client = MirrorCClient::new(&http);
    for (current, expected) in [
        ("", UpdateStatus::Installed),
        ("v1", UpdateStatus::Updated),
        ("v2", UpdateStatus::Skipped),
    ] {
        let result = client
            .update(
                &MirrorUpdateRequest {
                    kind: RepositoryKind::Main,
                    channel: UpdateChannel::Stable,
                    current_version: current,
                    cdk: "local-test-only",
                    target_dir: target.path(),
                },
                &NoopOutput,
            )
            .unwrap();
        assert_eq!(result.status, expected);
        assert_eq!(
            fs::read_to_string(&local_config).unwrap(),
            "local profile stays unchanged"
        );
    }
    assert_eq!(
        http.downloads.get(),
        2,
        "Current versions must not download again"
    );
    assert_eq!(
        fs::read_to_string(target.path().join("main.py")).unwrap(),
        "version two"
    );
    assert_eq!(
        fs::read_to_string(target.path().join("new.txt")).unwrap(),
        "new"
    );
    assert_eq!(
        fs::read_to_string(target.path().join("unchanged.txt")).unwrap(),
        "keep"
    );
    assert!(!target.path().join("obsolete.txt").exists());
}

#[test]
fn cdk_errors_never_download_or_modify_existing_files_even_at_the_latest_version() {
    let target = tempfile::tempdir().unwrap();
    let sentinel = target.path().join("existing.json");
    fs::write(&sentinel, "untouched").unwrap();
    for code in 7001..=7005 {
        let http = Packages {
            responses: RefCell::new(VecDeque::from([json!({
                "code":code,"msg":"CDK rejected","data":{"version_name":"current"}
            })])),
            packages: RefCell::new(VecDeque::new()),
            downloads: Cell::new(0),
        };
        let result = MirrorCClient::new(&http).update(
            &MirrorUpdateRequest {
                kind: RepositoryKind::Main,
                channel: UpdateChannel::Stable,
                current_version: "current",
                cdk: "local-test-only",
                target_dir: target.path(),
            },
            &NoopOutput,
        );
        assert!(result.is_err());
        assert_eq!(http.downloads.get(), 0);
        assert_eq!(fs::read_to_string(&sentinel).unwrap(), "untouched");
    }
}
