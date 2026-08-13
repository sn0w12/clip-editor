//! CLI entry point. Capture and mixer logic lives in the `screencap` library
//! (`src/lib.rs`); this file only parses arguments and dispatches.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use screencap::{config, error, hotkey, replay, schema};

#[derive(Parser)]
#[command(
    name = "screencap",
    version,
    about = "Crash-tolerant multi-track replay buffer for Windows",
    long_about = "Continuously captures the selected monitor and configured audio \
                  sources into a rolling buffer, then saves the newest N seconds \
                  as <base>_<window-title>.mp4 when the global hotkey is pressed."
)]
struct Cli {
    /// Path to the config file (defaults to the platform config dir).
    #[arg(long, global = true)]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the replay buffer until the hotkey saves or Ctrl-C stops it (default).
    Run,
    /// Validate the configuration without opening any capture device.
    Validate,
    /// Write a starting configuration (fails if the file exists).
    Init {
        /// Write the full multi-track routing example instead of the minimal default.
        #[arg(long)]
        example: bool,
    },
    /// Print every configuration key with its type, default, and notes.
    Keys,
    /// Record the global hotkey by pressing it and write it into the config.
    Hotkey,
    /// List running processes with their executable names (for audio.processes[].executable).
    Processes {
        /// Only show names containing this substring.
        #[arg(long)]
        contains: Option<String>,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let command = cli.command.unwrap_or(Command::Run);

    // Info logs on stdout, warnings/errors on stderr. ANSI colors only when
    // stdout is a terminal — redirected files must stay plain (the integration
    // tests parse the log for exact strings).
    let ansi = std::io::IsTerminal::is_terminal(&std::io::stdout());
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stdout)
        .with_ansi(ansi)
        .with_target(false)
        .init();

    match command {
        Command::Run => match replay::run(cli.config) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        },
        Command::Validate => match validate(cli.config) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        },
        Command::Init { example } => match init(cli.config, example) {
            Ok(path) => {
                println!(
                    "{} configuration written to {}",
                    if example { "example" } else { "starting" },
                    path.display()
                );
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        },
        Command::Keys => {
            print!("{}", schema::print_keys());
            ExitCode::SUCCESS
        }
        Command::Hotkey => match hotkey::record(cli.config.as_deref()) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        },
        Command::Processes { contains } => match list_processes(contains.as_deref()) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        },
    }
}

/// Load and validate the config, then report the resolved monitor, hotkey,
/// sources, and track table without opening any capture device.
fn validate(config_path: Option<PathBuf>) -> Result<(), error::ConfigError> {
    let path = match &config_path {
        Some(p) => p.clone(),
        None => config::default_config_path(),
    };
    println!("config: {}", path.display());
    let cfg = config::Config::load(config_path.as_deref())?;

    // Monitor resolution is a pure query on Windows; elsewhere only the spec
    // is reported.
    #[cfg(windows)]
    {
        use screencap::video::{self, VideoSettings};
        let settings = VideoSettings {
            monitor: cfg.replay.monitor.clone(),
            fps: cfg.replay.fps,
            cursor: cfg.video.cursor,
        };
        let backend = video::create_backend(&settings)
            .map_err(|e| error::ConfigError::Validation(format!("{e}")))?;
        match backend.resolve() {
            Ok(info) => println!(
                "monitor: {} ({}x{} @ {} fps)",
                cfg.replay.monitor.describe(),
                info.width,
                info.height,
                info.fps
            ),
            Err(e) => {
                return Err(error::ConfigError::Validation(format!("{e}")));
            }
        }
    }
    #[cfg(not(windows))]
    {
        println!(
            "monitor: {} (resolution available on Windows only)",
            cfg.replay.monitor.describe()
        );
    }

    println!();
    print!("{}", cfg.describe());
    println!("configuration is valid");
    Ok(())
}

/// Write the starting or example configuration; refuse to overwrite.
fn init(config_path: Option<PathBuf>, example: bool) -> Result<PathBuf, error::ConfigError> {
    let path = match config_path {
        Some(p) => p,
        None => config::default_config_path(),
    };
    let content = if example {
        config::SAMPLE_CONFIG
    } else {
        config::MINIMAL_CONFIG
    };
    config::write_config(&path, content)?;
    Ok(path)
}

/// Print pid + executable name for every running process, so users can find
/// the right `audio.processes[].executable` for their apps.
fn list_processes(contains: Option<&str>) -> Result<(), error::RunError> {
    let mut system = sysinfo::System::new_all();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let mut rows: Vec<(u32, String)> = system
        .processes()
        .iter()
        .map(|(pid, process)| (pid.as_u32(), process.name().to_string_lossy().into_owned()))
        .filter(|(_, name)| match contains {
            Some(needle) => name.to_lowercase().contains(&needle.to_lowercase()),
            None => true,
        })
        .collect();
    rows.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
    for (pid, name) in rows {
        println!("{pid:>8}  {name}");
    }
    Ok(())
}
