//! Native live preview (egui). The window shows pages rasterized from the
//! same Typst document the PDF export writes, so preview and export match.
//!
//! A worker thread renders; a filesystem watcher (debounced 250 ms) requests
//! new renders. A result is published only if its input snapshot still
//! matches the files on disk; otherwise it re-renders. On failure
//! the last good pages stay visible under an error banner.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use eframe::egui;
use notify::{RecursiveMode, Watcher};
use typst_layout::PagedDocument;

use crate::config::ConfigSources;
use crate::error::RenderError;
use crate::output::{default_output_path, validate_output_path, write_atomically};
use crate::render::{Rendered, Snapshot, render, snapshot_current};

const DEBOUNCE: Duration = Duration::from_millis(250);
const PAGE_GAP: f32 = 16.0;

/// A request to render the current files. Queued requests coalesce.
struct Request;

enum Update {
    Rendering,
    Done(Box<Rendered>),
    Failed(RenderError),
}

struct Good {
    document: Arc<PagedDocument>,
    pdf: Arc<Vec<u8>>,
    dependencies: Vec<PathBuf>,
    snapshot: Snapshot,
    warnings: Vec<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum Zoom {
    FitWidth,
    Scale(f32),
}

struct PreviewApp {
    source: PathBuf,
    requests: Sender<Request>,
    updates: Receiver<Update>,
    good: Option<Good>,
    error: Option<RenderError>,
    rendering: bool,
    notice: Option<(String, Instant)>,
    zoom: Zoom,
    /// Page index → texture at `texture_scale` pixels per pt. Cleared when a
    /// new render lands or the scale changes.
    textures: HashMap<usize, egui::TextureHandle>,
    warnings_dismissed: bool,
    texture_scale: f32,
}

pub fn run(source: PathBuf, sources: ConfigSources) -> Result<(), String> {
    let (request_tx, request_rx) = mpsc::channel();
    let (update_tx, update_rx) = mpsc::channel();
    let title = format!(
        "{} — docm",
        source.file_name().map_or_else(|| source.display().to_string(), |n| n.to_string_lossy().into_owned())
    );
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_title(title).with_inner_size([900.0, 1100.0]),
        ..Default::default()
    };
    let worker_source = source.clone();
    eframe::run_native(
        "docm",
        options,
        Box::new(move |creation| {
            let ctx = creation.egui_ctx.clone();
            let worker_tx = request_tx.clone();
            thread::spawn(move || worker(worker_source, sources, request_rx, worker_tx, update_tx, ctx));
            let _ = request_tx.send(Request);
            Ok(Box::new(PreviewApp {
                source,
                requests: request_tx,
                updates: update_rx,
                good: None,
                error: None,
                rendering: true,
                notice: None,
                zoom: Zoom::FitWidth,
                textures: HashMap::new(),
                texture_scale: 0.0,
                warnings_dismissed: false,
            }))
        }),
    )
    .map_err(|error| format!("Cannot open the preview window: {error}"))
}

/// Renders on request (coalescing queued requests) and owns the file watcher.
fn worker(
    source: PathBuf,
    sources: ConfigSources,
    requests: Receiver<Request>,
    self_tx: Sender<Request>,
    updates: Sender<Update>,
    ctx: egui::Context,
) {
    let watched: Arc<std::sync::Mutex<HashSet<PathBuf>>> = Arc::default();
    let filter = watched.clone();
    let (event_tx, event_rx) = mpsc::channel::<()>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        let relevant = {
            let watched = filter.lock().unwrap();
            event.paths.iter().any(|path| watched.contains(path) || watched.contains(&canonical(path)))
        };
        if relevant {
            let _ = event_tx.send(());
        }
    })
    .ok();
    // Debounce filesystem events into render requests.
    let debounce_tx = self_tx;
    thread::spawn(move || {
        while event_rx.recv().is_ok() {
            loop {
                match event_rx.recv_timeout(DEBOUNCE) {
                    Ok(()) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            if debounce_tx.send(Request).is_err() {
                return;
            }
        }
    });

    let mut directories: HashSet<PathBuf> = HashSet::new();
    while requests.recv().is_ok() {
        // Coalesce queued requests: one render reads the latest files.
        while requests.try_recv().is_ok() {}
        let _ = updates.send(Update::Rendering);
        ctx.request_repaint();
        let update = match render(&source, &sources) {
            Ok(rendered) => {
                update_watch(&mut watcher, &watched, &mut directories, rendered.dependencies.clone());
                Update::Done(Box::new(rendered))
            }
            Err(error) => {
                update_watch(&mut watcher, &watched, &mut directories, error.dependencies.clone());
                Update::Failed(error)
            }
        };
        if updates.send(update).is_err() {
            return;
        }
        ctx.request_repaint();
    }
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Watch each dependency's directory (files may not exist yet, and editors
/// replace files by renaming), filtering events to the dependency paths.
fn update_watch(
    watcher: &mut Option<notify::RecommendedWatcher>,
    watched: &std::sync::Mutex<HashSet<PathBuf>>,
    directories: &mut HashSet<PathBuf>,
    paths: Vec<PathBuf>,
) {
    let Some(watcher) = watcher else { return };
    let mut set = watched.lock().unwrap();
    for path in paths {
        if path.as_os_str().is_empty() || path.starts_with("<") {
            continue;
        }
        set.insert(canonical(&path));
        set.insert(path.clone());
        if let Some(parent) = path.parent() {
            let directory = canonical(parent);
            if directories.insert(directory.clone()) {
                let _ = watcher.watch(&directory, RecursiveMode::NonRecursive);
            }
        }
    }
}

impl PreviewApp {
    fn receive(&mut self) {
        while let Ok(update) = self.updates.try_recv() {
            match update {
                Update::Rendering => self.rendering = true,
                Update::Done(rendered) => {
                    self.rendering = false;
                    // Publish only while the inputs still match what was read.
                    if !snapshot_current(&rendered.snapshot) {
                        let _ = self.requests.send(Request);
                        continue;
                    }
                    self.error = None;
                    self.textures.clear();
                    let warnings: Vec<String> = rendered.warnings.iter().map(ToString::to_string).collect();
                    // A dismissed banner returns only when the warnings change.
                    if self.good.as_ref().is_none_or(|good| good.warnings != warnings) {
                        self.warnings_dismissed = false;
                    }
                    self.good = Some(Good {
                        document: Arc::new(rendered.document),
                        pdf: Arc::new(rendered.pdf),
                        dependencies: rendered.dependencies,
                        snapshot: rendered.snapshot,
                        warnings,
                    });
                }
                Update::Failed(error) => {
                    self.rendering = false;
                    self.error = Some(error);
                }
            }
        }
    }

    fn export(&mut self) {
        let Some(good) = &self.good else { return };
        if self.error.is_some() || !snapshot_current(&good.snapshot) {
            self.notice = Some((
                "The document has changed or has errors; export waits for a successful render".into(),
                Instant::now(),
            ));
            let _ = self.requests.send(Request);
            return;
        }
        let default = default_output_path(&self.source);
        let mut dialog = rfd::FileDialog::new().add_filter("PDF", &["pdf"]);
        if let Some(directory) = default.parent() {
            dialog = dialog.set_directory(directory);
        }
        if let Some(name) = default.file_name() {
            dialog = dialog.set_file_name(name.to_string_lossy());
        }
        let Some(destination) = dialog.save_file() else { return };
        let snapshot = good.snapshot.clone();
        let result = validate_output_path(&destination, &good.dependencies)
            .and_then(|()| write_atomically(&destination, &good.pdf, || snapshot_current(&snapshot)));
        self.notice = Some((
            match result {
                Ok(()) => format!("Saved {}", destination.display()),
                Err(message) => format!("Export failed: {message}"),
            },
            Instant::now(),
        ));
    }

    fn toolbar(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            let can_export = self.good.is_some();
            if ui.add_enabled(can_export, egui::Button::new("Export PDF…")).clicked() {
                self.export();
            }
            ui.separator();
            if ui.button("−").on_hover_text("Zoom out (⌘−)").clicked() {
                self.zoom = Zoom::Scale((self.scale_hint() / 1.2).max(0.25));
            }
            let label = match self.zoom {
                Zoom::FitWidth => "Fit width".to_owned(),
                Zoom::Scale(scale) => format!("{:.0}%", scale * 100.0),
            };
            if ui.button(label).on_hover_text("Fit width (⌘0)").clicked() {
                self.zoom = Zoom::FitWidth;
            }
            if ui.button("+").on_hover_text("Zoom in (⌘+)").clicked() {
                self.zoom = Zoom::Scale((self.scale_hint() * 1.2).min(5.0));
            }
            ui.separator();
            let pages = self.good.as_ref().map_or(0, |good| good.document.pages().len());
            ui.label(format!("{pages} page{}", if pages == 1 { "" } else { "s" }));
            if self.rendering {
                ui.spinner();
                ui.label("Rendering…");
            } else if self.error.is_none() && self.good.is_some() {
                ui.label("Up to date");
            }
        });
    }

    /// The current scale, for relative zoom steps from fit-width.
    fn scale_hint(&self) -> f32 {
        match self.zoom {
            Zoom::Scale(scale) => scale,
            Zoom::FitWidth => 1.0,
        }
    }

    fn banners(&mut self, ui: &mut egui::Ui) {
        if let Some(error) = &self.error {
            let stale = if self.good.is_some() { " (showing the last successful render)" } else { "" };
            egui::Frame::new().fill(egui::Color32::from_rgb(254, 226, 226)).inner_margin(8.0).show(ui, |ui| {
                ui.colored_label(egui::Color32::from_rgb(153, 27, 27), format!("{error}{stale}"));
            });
        }
        let warnings = self.good.as_ref().map_or(&[][..], |good| &good.warnings[..]);
        if self.error.is_none() && !warnings.is_empty() && !self.warnings_dismissed {
            let mut dismiss = false;
            egui::Frame::new().fill(egui::Color32::from_rgb(254, 243, 199)).inner_margin(8.0).show(ui, |ui| {
                ui.horizontal_top(|ui| {
                    ui.vertical(|ui| {
                        for warning in warnings {
                            ui.colored_label(egui::Color32::from_rgb(146, 64, 14), format!("Warning: {warning}"));
                        }
                    });
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                        dismiss = ui.small_button("✕").on_hover_text("Dismiss").clicked();
                    });
                });
            });
            self.warnings_dismissed = dismiss;
        }
        if let Some((message, at)) = &self.notice {
            if at.elapsed() < Duration::from_secs(6) {
                ui.label(message.as_str());
                ui.ctx().request_repaint_after(Duration::from_secs(1));
            } else {
                self.notice = None;
            }
        }
    }

    fn pages(&mut self, ui: &mut egui::Ui) {
        let Some(good) = &self.good else {
            if self.error.is_none() {
                ui.centered_and_justified(|ui| ui.spinner());
            }
            return;
        };
        let document = good.document.clone();
        let available = ui.available_width() - 2.0 * PAGE_GAP;
        let widest = document.pages().iter().map(|page| page.frame.width().to_pt() as f32).fold(1.0, f32::max);
        let points_per_pt = match self.zoom {
            // Quantized so window resizing does not re-rasterize every frame.
            Zoom::FitWidth => ((available / widest).max(0.1) * 50.0).floor() / 50.0,
            Zoom::Scale(scale) => scale * 96.0 / 72.0,
        };
        let pixel_per_pt = points_per_pt * ui.ctx().pixels_per_point();
        if pixel_per_pt != self.texture_scale {
            self.textures.clear();
            self.texture_scale = pixel_per_pt;
        }
        let sizes: Vec<egui::Vec2> = document
            .pages()
            .iter()
            .map(|page| {
                egui::vec2(page.frame.width().to_pt() as f32, page.frame.height().to_pt() as f32) * points_per_pt
            })
            .collect();
        let textures = &mut self.textures;
        egui::ScrollArea::both().auto_shrink(false).show_viewport(ui, |ui, viewport| {
            let total_height: f32 = sizes.iter().map(|s| s.y + PAGE_GAP).sum::<f32>() + PAGE_GAP;
            let total_width = sizes.iter().map(|s| s.x).fold(0.0, f32::max) + 2.0 * PAGE_GAP;
            let width = total_width.max(ui.available_width());
            let (rect, _) = ui.allocate_exact_size(egui::vec2(width, total_height), egui::Sense::hover());
            let mut y = PAGE_GAP;
            for (index, size) in sizes.iter().enumerate() {
                let page_rect =
                    egui::Rect::from_min_size(egui::pos2(rect.left() + (width - size.x) / 2.0, rect.top() + y), *size);
                y += size.y + PAGE_GAP;
                let visible = viewport.translate(rect.min.to_vec2()).intersects(page_rect.expand(size.y));
                ui.painter().rect_filled(page_rect, 0.0, egui::Color32::WHITE);
                if !visible {
                    continue;
                }
                let texture = textures.entry(index).or_insert_with(|| {
                    let pixmap = typst_render::render(
                        &document.pages()[index],
                        &typst_render::RenderOptions {
                            pixel_per_pt: (pixel_per_pt as f64).into(),
                            ..Default::default()
                        },
                    );
                    let image = egui::ColorImage::from_rgba_premultiplied(
                        [pixmap.width() as usize, pixmap.height() as usize],
                        pixmap.data(),
                    );
                    ui.ctx().load_texture(format!("page-{index}"), image, egui::TextureOptions::LINEAR)
                });
                ui.painter().image(
                    texture.id(),
                    page_rect,
                    egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)),
                    egui::Color32::WHITE,
                );
            }
        });
    }

    fn shortcuts(&mut self, ctx: &egui::Context) {
        let (export, zoom_in, zoom_out, fit) = ctx.input_mut(|input| {
            let command = egui::Modifiers::COMMAND;
            (
                input.consume_key(command, egui::Key::S),
                input.consume_key(command, egui::Key::Plus) || input.consume_key(command, egui::Key::Equals),
                input.consume_key(command, egui::Key::Minus),
                input.consume_key(command, egui::Key::Num0),
            )
        });
        if export {
            self.export();
        }
        if zoom_in {
            self.zoom = Zoom::Scale((self.scale_hint() * 1.2).min(5.0));
        }
        if zoom_out {
            self.zoom = Zoom::Scale((self.scale_hint() / 1.2).max(0.25));
        }
        if fit {
            self.zoom = Zoom::FitWidth;
        }
    }
}

impl eframe::App for PreviewApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.receive();
        let ctx = ui.ctx().clone();
        self.shortcuts(&ctx);
        egui::Panel::top("toolbar").show(ui, |ui| {
            ui.add_space(4.0);
            self.toolbar(ui);
            self.banners(ui);
            ui.add_space(4.0);
        });
        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(egui::Color32::from_gray(64)))
            .show(ui, |ui| self.pages(ui));
    }
}
