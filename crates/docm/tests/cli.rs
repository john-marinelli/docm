use std::fs;
use std::process::{Command, Output};

fn docm(dir: &std::path::Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_docm"))
        .args(args)
        .current_dir(dir)
        // Isolate from the user's global theme.
        .env("HOME", dir)
        .env("XDG_CONFIG_HOME", dir.join("xdg"))
        .output()
        .unwrap()
}

#[test]
fn render_writes_default_output() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("notes.md"), "# Notes\n").unwrap();
    let output = docm(dir.path(), &["r", "notes.md"]);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(fs::read(dir.path().join("notes.pdf")).unwrap().starts_with(b"%PDF-"));
}

#[test]
fn render_to_stdout_and_explicit_path() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("notes.md"), "# Notes\n").unwrap();
    let output = docm(dir.path(), &["r", "notes.md", "-o", "-"]);
    assert!(output.status.success());
    assert!(output.stdout.starts_with(b"%PDF-"));
    assert!(output.stderr.is_empty());
    let output = docm(dir.path(), &["r", "--config", "theme.toml", "notes.md", "-o", "out.pdf"]);
    assert_eq!(output.status.code(), Some(1), "an explicit config must exist");
    let output = docm(dir.path(), &["r", "notes.md", "-o", "out.pdf"]);
    assert!(output.status.success());
    assert!(dir.path().join("out.pdf").exists());
}

#[test]
fn render_refuses_to_overwrite_inputs() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("notes.md"), "# Notes\n").unwrap();
    let output = docm(dir.path(), &["r", "notes.md", "-o", "notes.md"]);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(fs::read_to_string(dir.path().join("notes.md")).unwrap(), "# Notes\n");
}

#[test]
fn exit_codes() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(docm(dir.path(), &[]).status.code(), Some(2));
    assert_eq!(docm(dir.path(), &["r"]).status.code(), Some(2));
    assert_eq!(docm(dir.path(), &["--bogus"]).status.code(), Some(2));
    assert_eq!(docm(dir.path(), &["--version"]).status.code(), Some(0));
    let missing = docm(dir.path(), &["r", "missing.md"]);
    assert_eq!(missing.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("missing.md"));
    fs::write(dir.path().join("bad.md"), "<center>\n").unwrap();
    let bad = docm(dir.path(), &["r", "bad.md"]);
    assert_eq!(bad.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&bad.stderr).contains("bad.md:1:1: Unclosed macro tag <center>"));
}

#[test]
fn render_prints_warnings_and_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("old.md"), "```mermaid\nflowchart LR\n```\n").unwrap();
    let output = docm(dir.path(), &["r", "old.md"]);
    assert!(output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("docm: warning: ") && stderr.contains("old.md:1:1: Mermaid"), "{stderr}");
}
