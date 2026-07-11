#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpcLane {
    Control,
    Message,
    Bulk,
    RemoteMedia,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackpressureAction {
    Wait,
    Error,
    DropOldest,
    CoalesceLatest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LanePolicy {
    pub lane: IpcLane,
    pub reliable: bool,
    pub backpressure: BackpressureAction,
    pub max_queue_bytes: usize,
}

impl LanePolicy {
    pub const fn for_lane(lane: IpcLane) -> Self {
        match lane {
            IpcLane::Control => Self {
                lane,
                reliable: true,
                backpressure: BackpressureAction::Error,
                max_queue_bytes: 256 * 1024,
            },
            IpcLane::Message => Self {
                lane,
                reliable: true,
                backpressure: BackpressureAction::Wait,
                max_queue_bytes: 2 * 1024 * 1024,
            },
            IpcLane::Bulk => Self {
                lane,
                reliable: true,
                backpressure: BackpressureAction::Wait,
                max_queue_bytes: 16 * 1024 * 1024,
            },
            IpcLane::RemoteMedia => Self {
                lane,
                reliable: false,
                backpressure: BackpressureAction::DropOldest,
                max_queue_bytes: 8 * 1024 * 1024,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_lane_is_reliable_and_never_drops() {
        let policy = LanePolicy::for_lane(IpcLane::Control);

        assert!(policy.reliable);
        assert_eq!(policy.backpressure, BackpressureAction::Error);
    }

    #[test]
    fn message_and_bulk_lanes_wait_instead_of_dropping() {
        assert_eq!(
            LanePolicy::for_lane(IpcLane::Message).backpressure,
            BackpressureAction::Wait
        );
        assert_eq!(
            LanePolicy::for_lane(IpcLane::Bulk).backpressure,
            BackpressureAction::Wait
        );
    }

    #[test]
    fn remote_media_lane_can_drop_old_frames() {
        let policy = LanePolicy::for_lane(IpcLane::RemoteMedia);

        assert!(!policy.reliable);
        assert_eq!(policy.backpressure, BackpressureAction::DropOldest);
    }
}
