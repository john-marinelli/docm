use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};

use docm::config::ConfigSources;
use docm::output::{default_output_path, validate_output_path, write_atomically};

/// Render Markdown to PDF through Typst, with a native live preview.
///
/// `docm FILE` opens a preview window that re-renders on save.
/// `docm r FILE` renders a PDF without opening a window.
#[derive(Parser)]
#[command(
    name = "docm",
    version,
    args_conflicts_with_subcommands = true,
    after_help = "Use `docm -- r` to preview a file literally named r; use -- before dash-prefixed filenames."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    preview: PreviewArgs,
}

#[derive(Args)]
struct PreviewArgs {
    /// Markdown document to preview
    filename: Option<PathBuf>,
    /// Additional TOML theme, applied after the global and local themes
    #[arg(long, value_name = "FILE")]
    config: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Command {
    /// Render a PDF without opening a preview window
    R {
        /// Markdown document
        filename: PathBuf,
        /// PDF destination, or - for stdout (default: FILENAME with .pdf)
        #[arg(short, long, value_name = "PATH")]
        output: Option<PathBuf>,
        /// Additional TOML theme, applied after the global and local themes
        #[arg(long, value_name = "FILE")]
        config: Option<PathBuf>,
    },
}

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            let _ = error.print();
            return if error.use_stderr() { ExitCode::from(2) } else { ExitCode::SUCCESS };
        }
    };
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            eprintln!("docm: cannot determine the current directory: {error}");
            return ExitCode::FAILURE;
        }
    };
    match cli.command {
        Some(Command::R { filename, output, config }) => {
            render(&filename, output, ConfigSources::for_invocation(cwd, config))
        }
        None => {
            let Some(filename) = cli.preview.filename else {
                use clap::CommandFactory;
                let _ = Cli::command().print_help();
                eprintln!("\ndocm: a Markdown filename is required");
                return ExitCode::from(2);
            };
            let source = cwd.join(&filename);
            match docm::preview::run(source, ConfigSources::for_invocation(cwd, cli.preview.config)) {
                Ok(()) => ExitCode::SUCCESS,
                Err(message) => {
                    eprintln!("docm: {message}");
                    ExitCode::FAILURE
                }
            }
        }
    }
}

fn render(filename: &std::path::Path, output: Option<PathBuf>, sources: ConfigSources) -> ExitCode {
    let rendered = match docm::render::render(filename, &sources) {
        Ok(rendered) => rendered,
        Err(error) => {
            eprintln!("docm: {error}");
            return ExitCode::FAILURE;
        }
    };
    for warning in &rendered.warnings {
        eprintln!("docm: warning: {warning}");
    }
    let result = match output.as_deref() {
        Some(path) if path.as_os_str() == "-" => {
            let mut stdout = std::io::stdout().lock();
            stdout.write_all(&rendered.pdf).and_then(|()| stdout.flush()).map_err(|error| error.to_string())
        }
        _ => {
            let destination =
                output.map_or_else(|| default_output_path(&sources.cwd.join(filename)), |path| sources.cwd.join(path));
            validate_output_path(&destination, &rendered.dependencies)
                .and_then(|()| write_atomically(&destination, &rendered.pdf, || true))
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("docm: {message}");
            ExitCode::FAILURE
        }
    }
}
