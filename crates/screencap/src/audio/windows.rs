//! Windows application-loopback capture (build 20348+). A manager enumerates
//! render sessions once per second, roots each session PID at the topmost
//! ancestor that also has a session (so a process tree is captured once), maps
//! roots to configured sources by executable name, and runs one WASAPI
//! loopback worker per root.
//!
//! Invariants:
//! - Loopback binds to the application's render session, never a system
//!   endpoint — muted applications stay muted on every track.
//! - Nothing reads or writes Windows volume/mute state; `muted` is routing
//!   metadata only.
//! - An unopenable root (PID 0, no captureable session) is omitted with a
//!   warning, never replaced by a system-wide mix.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tracing::{debug, warn};
use wasapi::{
    AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat, initialize_mta,
};

use crate::audio::resample::{StreamingResampler, convert_channels_into};
use crate::audio::{AudioBlock, AudioError, AudioEvent, SourceInfo, SourceKey, SourceKind};
use crate::config::ProcessRule;
use crate::error::RunError;
use crate::util::{RateLimiter, send_drop_oldest};

/// Windows 10 build that added application-loopback (process-tree) capture.
const MIN_BUILD: u32 = 20348;

/// How often session/process changes are re-polled.
const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// WASAPI capture rate (fixed); resampled to `audio.sample_rate` when that
/// differs — the default 48000 is a passthrough.
const LOOPBACK_RATE: u32 = 48000;
const LOOPBACK_CHANNELS: u16 = 2;

/// Start the process-audio manager. Spawns its own thread; returns once the
/// manager is running (or fails the Windows build-floor check).
pub fn spawn_process_audio(
    rules: Vec<ProcessRule>,
    origin: std::time::Instant,
    event_tx: Sender<AudioEvent>,
    event_rx: Receiver<AudioEvent>,
    err_tx: Sender<RunError>,
    shutdown: Receiver<()>,
    sample_rate: u32,
    channels: u16,
) -> Result<(), AudioError> {
    check_windows_build()?;

    let manager = Arc::new(Manager {
        rules,
        origin,
        event_tx,
        event_rx,
        err_tx,
        shutdown,
        sample_rate,
        channels,
    });
    let manager_handle = manager.clone();
    thread::Builder::new()
        .name("audio-manager".to_string())
        .spawn(move || {
            let _ = manager_handle.run();
        })
        .map_err(|e| AudioError::Capture(format!("cannot spawn audio manager: {e}")))?;
    Ok(())
}

/// Windows build check: application-loopback requires build 20348+.
fn check_windows_build() -> Result<(), AudioError> {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;

    unsafe {
        let mut info: OSVERSIONINFOW = std::mem::zeroed();
        info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
        let status = RtlGetVersion(&mut info);
        if status.is_ok() {
            let build = info.dwBuildNumber;
            if info.dwMajorVersion < 10 || (info.dwMajorVersion == 10 && build < MIN_BUILD) {
                return Err(AudioError::WindowsTooOld(format!(
                    "build {build} (major {})",
                    info.dwMajorVersion
                )));
            }
            debug!(build, "Windows build check passed");
            Ok(())
        } else {
            Err(AudioError::Capture(format!(
                "cannot query Windows version: status 0x{:08X}",
                status.0
            )))
        }
    }
}

struct Manager {
    rules: Vec<ProcessRule>,
    origin: std::time::Instant,
    event_tx: Sender<AudioEvent>,
    event_rx: Receiver<AudioEvent>,
    err_tx: Sender<RunError>,
    shutdown: Receiver<()>,
    sample_rate: u32,
    channels: u16,
}

impl Manager {
    fn run(&self) {
        let _ = initialize_mta();
        let mut workers: HashMap<SourceKey, Worker> = HashMap::new();
        // `new()` loads no process data; the poll below performs a targeted
        // refresh and only needs executable names and parents.
        let mut system = System::new();
        let mut last_warn: RateLimiter = RateLimiter::new(Duration::from_secs(5));

        loop {
            if self.shutdown.try_recv().is_ok() {
                break;
            }
            match self.poll(&mut system, &mut workers, &mut last_warn) {
                Ok(()) => {}
                Err(e) => {
                    // Session enumeration failed: report terminal and stop.
                    let _ = self
                        .err_tx
                        .send(RunError::Capture(crate::error::CaptureError::Audio(e)));
                    break;
                }
            }
            let _ = self.shutdown.recv_timeout(POLL_INTERVAL);
        }

        // Stop all workers.
        for (key, handle) in workers.drain() {
            handle.stop();
            let _ = self.event_tx.send(AudioEvent::SourceRemoved(key));
        }
    }

    fn poll(
        &self,
        system: &mut System,
        workers: &mut HashMap<SourceKey, Worker>,
        last_warn: &mut RateLimiter,
    ) -> Result<(), AudioError> {
        let session_pids = enumerate_session_pids()?;
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::OnlyIfNotSet),
        );

        // Root each session PID at the topmost ancestor that also has a
        // session, so a process tree is captured exactly once.
        let roots = root_pids(&session_pids, system);

        let mut wanted: HashMap<SourceKey, RootTarget> = HashMap::new();
        for pid in &roots {
            let exe = system
                .process(*pid)
                .and_then(|p| p.name().to_str().map(|s| s.to_string()))
                .unwrap_or_default();
            let (key, tags, include_children) = match self.match_rule(&exe) {
                Some(rule) => (
                    SourceKey::process(&rule.id),
                    rule.tags.clone(),
                    rule.include_children,
                ),
                None => (SourceKey::unknown_process(pid.as_u32()), vec![], true),
            };
            wanted.entry(key.clone()).or_insert(RootTarget {
                pid: *pid,
                tags,
                include_children,
                executable: if exe.is_empty() { None } else { Some(exe) },
            });
        }

        // Start workers for new roots, stop workers for gone roots.
        let active: HashSet<SourceKey> = wanted.keys().cloned().collect();
        let existing: HashSet<SourceKey> = workers.keys().cloned().collect();
        for key in existing.difference(&active) {
            if let Some(handle) = workers.remove(key) {
                handle.stop();
                let _ = self.event_tx.send(AudioEvent::SourceRemoved(key.clone()));
            }
        }
        for (key, target) in wanted.into_iter() {
            if workers.contains_key(&key) {
                continue;
            }
            let info = SourceInfo {
                key: key.clone(),
                kind: SourceKind::Process,
                tags: target.tags.clone(),
                executable: target.executable.clone(),
            };
            match self.spawn_worker(target.pid, target.include_children, &key, &info) {
                Ok(handle) => {
                    workers.insert(key.clone(), handle);
                    if key.0.starts_with("process:") {
                        // Unknown roots are dynamic; configured sources were
                        // registered up front by the supervisor.
                        let _ = self.event_tx.send(AudioEvent::SourceAdded(info));
                    }
                    debug!(
                        source = %key.0,
                        executable = target.executable.as_deref().unwrap_or("?"),
                        "started process-loopback worker"
                    );
                }
                Err(e) => {
                    if last_warn.should_emit() {
                        warn!(
                            source = %key.0,
                            executable = target.executable.as_deref().unwrap_or("?"),
                            error = %e,
                            "omitting audio source (no captureable render session)"
                        );
                    }
                }
            }
        }
        Ok(())
    }

    fn match_rule(&self, exe: &str) -> Option<&ProcessRule> {
        self.rules
            .iter()
            .find(|r| r.executable.eq_ignore_ascii_case(exe))
    }

    fn spawn_worker(
        &self,
        pid: sysinfo::Pid,
        include_children: bool,
        key: &SourceKey,
        info: &SourceInfo,
    ) -> Result<Worker, AudioError> {
        Worker::start(
            pid.as_u32(),
            include_children,
            key.clone(),
            info.clone(),
            self.origin,
            self.event_tx.clone(),
            self.event_rx.clone(),
            self.shutdown.clone(),
            self.sample_rate,
            self.channels,
        )
    }
}

struct RootTarget {
    pid: sysinfo::Pid,
    tags: Vec<String>,
    include_children: bool,
    executable: Option<String>,
}

/// Enumerate the PIDs of active render audio sessions.
fn enumerate_session_pids() -> Result<HashSet<sysinfo::Pid>, AudioError> {
    let enumerator = DeviceEnumerator::new()
        .map_err(|e| AudioError::Capture(format!("DeviceEnumerator: {e}")))?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| AudioError::Capture(format!("default render device: {e}")))?;
    let manager = device
        .get_iaudiosessionmanager()
        .map_err(|e| AudioError::Capture(format!("audio session manager: {e}")))?;
    let sessions = manager
        .get_audiosessionenumerator()
        .map_err(|e| AudioError::Capture(format!("audio session enumerator: {e}")))?;
    let count = sessions
        .get_count()
        .map_err(|e| AudioError::Capture(format!("session count: {e}")))?;

    let mut pids = HashSet::new();
    for i in 0..count {
        match sessions.get_session(i) {
            Ok(session) => match session.get_process_id() {
                Ok(pid) if pid != 0 => {
                    pids.insert(Pid::from_u32(pid));
                }
                Ok(_) => {} // PID 0: system sounds, omit (plan §3.3)
                Err(e) => debug!(index = i, error = %e, "session without process id"),
            },
            Err(e) => debug!(index = i, error = %e, "cannot access session"),
        }
    }
    Ok(pids)
}

/// For every session PID, walk up to the topmost ancestor that also has a
/// session; return exactly those roots.
fn root_pids(session_pids: &HashSet<Pid>, system: &System) -> Vec<Pid> {
    root_pids_with(session_pids, |pid| {
        system.process(pid).and_then(|p| p.parent())
    })
}

/// Testable core of [`root_pids`]: `parent_of` resolves a PID's parent.
fn root_pids_with<F: Fn(Pid) -> Option<Pid>>(
    session_pids: &HashSet<Pid>,
    parent_of: F,
) -> Vec<Pid> {
    let mut roots: HashSet<Pid> = HashSet::new();
    for &pid in session_pids {
        let mut current = pid;
        let mut top = pid;
        let mut guard = 0;
        loop {
            guard += 1;
            if guard > 64 {
                break; // cycle guard
            }
            match parent_of(current) {
                Some(parent) if parent != current && session_pids.contains(&parent) => {
                    current = parent;
                    top = parent;
                }
                _ => break,
            }
        }
        roots.insert(top);
    }
    roots.into_iter().collect()
}

/// One application-loopback capture worker.
struct Worker {
    stop: Sender<()>,
    join: Option<thread::JoinHandle<()>>,
}

impl Worker {
    fn start(
        pid: u32,
        include_children: bool,
        _key: SourceKey,
        info: SourceInfo,
        origin: std::time::Instant,
        event_tx: Sender<AudioEvent>,
        event_rx: Receiver<AudioEvent>,
        shutdown: Receiver<()>,
        sample_rate: u32,
        channels: u16,
    ) -> Result<Worker, AudioError> {
        let (stop_tx, stop_rx) = crossbeam_channel::bounded::<()>(1);
        let join = thread::Builder::new()
            .name(format!("audio-worker-{pid}"))
            .spawn(move || {
                run_worker(
                    pid,
                    include_children,
                    info,
                    origin,
                    event_tx,
                    event_rx,
                    shutdown,
                    stop_rx,
                    sample_rate,
                    channels,
                )
            })
            .map_err(|e| AudioError::Capture(format!("cannot spawn worker: {e}")))?;
        Ok(Worker {
            stop: stop_tx,
            join: Some(join),
        })
    }

    fn stop(&self) {
        let _ = self.stop.try_send(());
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.stop.try_send(());
        if let Some(join) = self.join.take() {
            // Give the worker a moment to observe the stop signal.
            let _ = join.join();
        }
    }
}

/// Capture loop for one process root.
fn run_worker(
    pid: u32,
    include_children: bool,
    info: SourceInfo,
    origin: std::time::Instant,
    event_tx: Sender<AudioEvent>,
    event_rx: Receiver<AudioEvent>,
    shutdown: Receiver<()>,
    stop_rx: Receiver<()>,
    sample_rate: u32,
    channels: u16,
) {
    let _ = initialize_mta();
    let key = info.key.clone();

    let client = match AudioClient::new_application_loopback_client(pid, include_children) {
        Ok(c) => c,
        Err(e) => {
            warn!(
                source = %key.0,
                executable = info.executable.as_deref().unwrap_or("?"),
                error = %e,
                "cannot open application-loopback client; omitting source"
            );
            return;
        }
    };
    let mut client = client;
    let format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        LOOPBACK_RATE as usize,
        LOOPBACK_CHANNELS as usize,
        None,
    );
    if let Err(e) = client.initialize_client(
        &format,
        &Direction::Capture,
        &StreamMode::EventsShared {
            autoconvert: false,
            buffer_duration_hns: 1_000_000, // 100 ms
        },
    ) {
        warn!(source = %key.0, error = %e, "cannot initialize loopback client; omitting source");
        return;
    }
    let event_handle = match client.set_get_eventhandle() {
        Ok(h) => h,
        Err(e) => {
            warn!(source = %key.0, error = %e, "cannot create capture event; omitting source");
            return;
        }
    };
    let capture = match client.get_audiocaptureclient() {
        Ok(c) => c,
        Err(e) => {
            warn!(source = %key.0, error = %e, "cannot get capture client; omitting source");
            return;
        }
    };
    if let Err(e) = client.start_stream() {
        warn!(source = %key.0, error = %e, "cannot start loopback stream; omitting source");
        return;
    }

    let buffer_frames = client.get_buffer_size().unwrap_or(48_000) as usize;
    let bytes_per_frame = format.get_blockalign() as usize;
    let mut read_buf = vec![0u8; buffer_frames * bytes_per_frame];
    // Reused decode/conversion scratch: the steady-state packet path
    // allocates nothing per read.
    let mut samples: Vec<f32> = Vec::new();
    let mut converted: Vec<f32> = Vec::new();
    let mut out: Vec<f32> = Vec::new();
    let mut resampler = StreamingResampler::new(LOOPBACK_RATE, sample_rate, channels, 960);
    let block_frames = (sample_rate as u64 * 20 / 1000) as usize; // 20 ms default blocks
    let block_dur = Duration::from_secs_f64(block_frames as f64 / sample_rate as f64);
    // Data-timeline PTS, aligned to the 20 ms window grid: burst reads stamp
    // distinct, uniformly spaced blocks and every block lands exactly on a
    // mixer window boundary (no split-block tails in the router).
    let mut next_pts: Option<Duration> = None;
    let mut limiter = RateLimiter::new(Duration::from_secs(5));

    loop {
        if stop_rx.try_recv().is_ok() || shutdown.try_recv().is_ok() {
            break;
        }
        match event_handle.wait_for_event(20) {
            Ok(()) => {}
            // Timeout: some sessions never signal their capture event; fall
            // through and poll for whatever data is available so the source
            // still emits silence at a steady cadence.
            Err(_) => {}
        }
        loop {
            match capture.get_next_packet_size() {
                Ok(Some(0)) | Ok(None) => break,
                Ok(Some(_frames)) => match capture.read_from_device(&mut read_buf) {
                    Ok((read, _info)) => {
                        let bytes = read as usize * bytes_per_frame;
                        f32s_from_le_into(&read_buf[..bytes], &mut samples);
                        let source: &[f32] = if channels != LOOPBACK_CHANNELS {
                            convert_channels_into(
                                &samples,
                                LOOPBACK_CHANNELS,
                                channels,
                                &mut converted,
                            );
                            &converted
                        } else {
                            &samples
                        };
                        match resampler.as_mut() {
                            Some(r) => {
                                r.push(source);
                                out.extend_from_slice(&r.take_output());
                            }
                            None => out.extend_from_slice(source),
                        }
                        while out.len() >= block_frames * channels as usize {
                            let block: Vec<f32> =
                                out.drain(..block_frames * channels as usize).collect();
                            let block_pts = match next_pts {
                                Some(pts) => pts,
                                None => {
                                    let start = origin.elapsed().saturating_sub(block_dur);
                                    Duration::from_millis(((start.as_millis() / 20) * 20) as u64)
                                }
                            };
                            next_pts = Some(block_pts + block_dur);
                            send_drop_oldest(
                                &event_tx,
                                &event_rx,
                                AudioEvent::Block(AudioBlock {
                                    source: key.clone(),
                                    pts: block_pts,
                                    sample_rate,
                                    channels,
                                    samples: block,
                                }),
                                &mut limiter,
                                "audio",
                            );
                        }
                    }
                    Err(e) => {
                        if limiter.should_emit() {
                            warn!(source = %key.0, error = %e, "loopback read failed; source paused");
                        }
                        break;
                    }
                },
                Err(_) => break,
            }
        }
    }

    let _ = client.stop_stream();
}

/// Decode little-endian f32le bytes into `out`, clearing it first. `out` is
/// reused across packets so the steady-state read path allocates nothing.
#[doc(hidden)]
pub fn f32s_from_le_into(bytes: &[u8], out: &mut Vec<f32>) {
    out.clear();
    #[cfg(target_endian = "little")]
    {
        if bytes.as_ptr() as usize % 4 == 0 && bytes.len() % 4 == 0 {
            // SAFETY: aligned f32-sized region; on little-endian the bytes
            // are the LE encoding.
            unsafe {
                out.extend_from_slice(std::slice::from_raw_parts(
                    bytes.as_ptr() as *const f32,
                    bytes.len() / 4,
                ));
            }
            return;
        }
    }
    for c in bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pids(ids: &[u32]) -> HashSet<Pid> {
        ids.iter().map(|&p| Pid::from_u32(p)).collect()
    }

    #[test]
    fn root_selection_keeps_only_topmost_session_ancestor() {
        // 100 -> 200 -> 300 chain; all three have sessions.
        let sessions = pids(&[100, 200, 300]);
        let parents = |pid: Pid| match pid.as_u32() {
            300 => Some(Pid::from_u32(200)),
            200 => Some(Pid::from_u32(100)),
            _ => None,
        };
        let roots = root_pids_with(&sessions, parents);
        assert_eq!(roots, vec![Pid::from_u32(100)]);
    }

    #[test]
    fn root_selection_keeps_roots_without_session_ancestors() {
        // 100 has a session; 300 has a session but its parent 200 does not.
        let sessions = pids(&[100, 300]);
        let parents = |pid: Pid| match pid.as_u32() {
            300 => Some(Pid::from_u32(200)),
            200 => Some(Pid::from_u32(100)),
            _ => None,
        };
        let mut roots = root_pids_with(&sessions, parents);
        roots.sort_by_key(|p| p.as_u32());
        assert_eq!(roots, vec![Pid::from_u32(100), Pid::from_u32(300)]);
    }

    #[test]
    fn root_selection_breaks_parent_cycles() {
        // 100 <-> 200 cycle; must terminate (guard) with a bounded result.
        let sessions = pids(&[100, 200]);
        let parents = |pid: Pid| {
            Some(if pid.as_u32() == 100 {
                Pid::from_u32(200)
            } else {
                Pid::from_u32(100)
            })
        };
        let roots = root_pids_with(&sessions, parents);
        assert!(roots.len() <= 2);
        assert!(roots.iter().all(|p| sessions.contains(p)));
    }
}
