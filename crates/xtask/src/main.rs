//! Repository helpers, run through the aliases in `.cargo/config.toml`:
//!
//! - `cargo bump patch|minor|major|X.Y.Z`: set the workspace version, update
//!   Cargo.lock, and commit `chore: release X.Y.Z` on main.
//! - `cargo tag-release`: tag the pushed main commit `vX.Y.Z` and push the
//!   tag, which starts the release workflow.
//! - `cargo dist`: build this host's release artifacts into dist/.
//! - `cargo xtask version`: print the current version.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

type Result<T = ()> = std::result::Result<T, String>;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["bump", level] => bump(level),
        ["tag-release"] => tag_release(),
        ["dist"] => dist(),
        ["version"] => version().map(|v| println!("{v}")),
        [] | ["help" | "--help" | "-h"] => {
            print!("{}", USAGE);
            Ok(())
        }
        _ => Err(format!("unknown command: {}\n\n{USAGE}", args.join(" "))),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}

const USAGE: &str = "\
Usage:
  cargo bump patch|minor|major|X.Y.Z   set the version, update Cargo.lock, commit on main
  cargo tag-release                    tag the pushed main commit vX.Y.Z and push the tag
  cargo dist                           build this host's release artifacts into dist/
  cargo xtask version                  print the current version

Release flow: cargo bump patch → git push → wait for CI → cargo tag-release
";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("repository root")
}

/// Run a command in the repository root, failing on a non-zero exit.
fn run(program: &str, args: &[&str]) -> Result {
    eprintln!("$ {program} {}", args.join(" "));
    let status = Command::new(program)
        .args(args)
        .current_dir(root())
        .status()
        .map_err(|e| format!("cannot run {program}: {e}"))?;
    if status.success() { Ok(()) } else { Err(format!("`{program} {}` failed", args.join(" "))) }
}

/// Run a command and return its trimmed stdout.
fn output(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program)
        .args(args)
        .current_dir(root())
        .output()
        .map_err(|e| format!("cannot run {program}: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "`{program} {}` failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// The `version = "..."` line inside `[workspace.package]`, as (line index, version).
fn version_line(manifest: &str) -> Result<(usize, String)> {
    let mut in_section = false;
    for (index, line) in manifest.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_section = trimmed == "[workspace.package]";
        } else if in_section && let Some(value) = trimmed.strip_prefix("version") {
            let value = value.trim_start().strip_prefix('=').map(str::trim).unwrap_or_default();
            return Ok((index, value.trim_matches('"').to_owned()));
        }
    }
    Err("Cargo.toml has no [workspace.package] version".into())
}

fn version() -> Result<String> {
    let manifest = std::fs::read_to_string(root().join("Cargo.toml")).map_err(|e| e.to_string())?;
    version_line(&manifest).map(|(_, version)| version)
}

fn parse(version: &str) -> Result<[u64; 3]> {
    let parts: Vec<u64> = version
        .split('.')
        .map(|p| p.parse().map_err(|_| ()))
        .collect::<std::result::Result<_, _>>()
        .map_err(|()| format!("not a MAJOR.MINOR.PATCH version: {version}"))?;
    parts.try_into().map_err(|_| format!("not a MAJOR.MINOR.PATCH version: {version}"))
}

/// Main, clean, and in sync with origin/main.
fn require_clean_main(action: &str) -> Result {
    let branch = output("git", &["branch", "--show-current"])?;
    if branch != "main" {
        return Err(format!("{action} runs on main (currently on {branch})"));
    }
    if !output("git", &["status", "--porcelain"])?.is_empty() {
        return Err(format!("{action} needs a clean working tree; commit or stash first"));
    }
    run("git", &["fetch", "--quiet", "origin", "main", "--tags"])?;
    Ok(())
}

fn bump(level: &str) -> Result {
    require_clean_main("cargo bump")?;
    if output("git", &["rev-parse", "HEAD"])? != output("git", &["rev-parse", "origin/main"])? {
        return Err("main differs from origin/main; pull or push first".into());
    }
    let current = version()?;
    let [major, minor, patch] = parse(&current)?;
    let next = match level {
        "patch" => format!("{major}.{minor}.{}", patch + 1),
        "minor" => format!("{major}.{}.0", minor + 1),
        "major" => format!("{}.0.0", major + 1),
        explicit => {
            let wanted = parse(explicit)?;
            if wanted <= [major, minor, patch] {
                return Err(format!("{explicit} is not newer than {current}"));
            }
            explicit.to_owned()
        }
    };
    if !output("git", &["tag", "--list", &format!("v{next}")])?.is_empty() {
        return Err(format!("tag v{next} already exists"));
    }

    let path = root().join("Cargo.toml");
    let manifest = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (index, _) = version_line(&manifest)?;
    let mut lines: Vec<String> = manifest.lines().map(str::to_owned).collect();
    let indent: String = lines[index].chars().take_while(|c| c.is_whitespace()).collect();
    lines[index] = format!("{indent}version = \"{next}\"");
    std::fs::write(&path, lines.join("\n") + "\n").map_err(|e| e.to_string())?;

    // Refresh Cargo.lock's entries for the workspace crates.
    run("cargo", &["update", "--workspace"])?;
    run("git", &["commit", "--quiet", "-am", &format!("chore: release {next}")])?;
    eprintln!(
        "\nVersion {current} → {next}, committed. Next:\n  git push\n  (wait for CI on main)\n  cargo tag-release"
    );
    Ok(())
}

fn tag_release() -> Result {
    require_clean_main("cargo tag-release")?;
    let head = output("git", &["rev-parse", "HEAD"])?;
    if head != output("git", &["rev-parse", "origin/main"])? {
        return Err("main differs from origin/main; push (and let CI pass) before tagging".into());
    }
    let version = version()?;
    let tag = format!("v{version}");
    if !output("git", &["tag", "--list", &tag])?.is_empty()
        || !output("git", &["ls-remote", "--tags", "origin", &format!("refs/tags/{tag}")])?.is_empty()
    {
        return Err(format!("{tag} already exists; run `cargo bump patch` (or minor/major) for a new version"));
    }
    run("git", &["tag", "--annotate", &tag, "--message", &format!("docm {version}")])?;
    run("git", &["push", "origin", &tag])?;
    eprintln!(
        "\nPushed {tag}. The release workflow builds, tests and publishes it, then opens a\n\"Homebrew: docm {version}\" PR; merge that PR to update the formula."
    );
    Ok(())
}

fn dist() -> Result {
    run("scripts/package.sh", &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_workspace_version_only() {
        let manifest =
            "[package]\nversion = \"9.9.9\"\n\n[workspace.package]\nedition = \"2024\"\nversion = \"0.2.0\"\n";
        assert_eq!(version_line(manifest).unwrap(), (5, "0.2.0".into()));
        assert!(version_line("[package]\nversion = \"1.0.0\"\n").is_err());
    }

    #[test]
    fn parses_versions() {
        assert_eq!(parse("1.2.3").unwrap(), [1, 2, 3]);
        assert!(parse("1.2").is_err());
        assert!(parse("v1.2.3").is_err());
    }
}
