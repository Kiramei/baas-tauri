use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState as GlobalShortcutState,
};

pub const TOGGLE_RUN_EVENT: &str = "baas-shortcut:toggle-run";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBindingRequest {
    pub id: String,
    pub config_id: String,
    pub accelerator: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutRegisteredBinding {
    pub id: String,
    pub config_id: String,
    pub accelerator: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutRejectedBinding {
    pub id: String,
    pub config_id: String,
    pub accelerator: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutRegistrationReport {
    pub registered: Vec<ShortcutRegisteredBinding>,
    pub rejected: Vec<ShortcutRejectedBinding>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutTogglePayload {
    pub id: String,
    pub config_id: String,
    pub accelerator: String,
}

#[derive(Debug, Clone)]
struct RegisteredBinding {
    id: String,
    config_id: String,
    accelerator: String,
}

impl RegisteredBinding {
    /// Handles the to public workflow.
    fn to_public(&self) -> ShortcutRegisteredBinding {
        ShortcutRegisteredBinding {
            id: self.id.clone(),
            config_id: self.config_id.clone(),
            accelerator: self.accelerator.clone(),
        }
    }

    /// Handles the to payload workflow.
    fn to_payload(&self) -> ShortcutTogglePayload {
        ShortcutTogglePayload {
            id: self.id.clone(),
            config_id: self.config_id.clone(),
            accelerator: self.accelerator.clone(),
        }
    }
}

#[derive(Default)]
pub struct ShortcutRegistry {
    bindings: Mutex<HashMap<Shortcut, RegisteredBinding>>,
}

impl ShortcutRegistry {
    /// Handles the snapshot workflow.
    fn snapshot(&self) -> Result<HashMap<Shortcut, RegisteredBinding>, String> {
        self.bindings
            .lock()
            .map_err(|_| "shortcut registry lock poisoned".to_string())
            .map(|bindings| bindings.clone())
    }

    /// Handles the replace workflow.
    fn replace(&self, next: HashMap<Shortcut, RegisteredBinding>) -> Result<(), String> {
        let mut bindings = self
            .bindings
            .lock()
            .map_err(|_| "shortcut registry lock poisoned".to_string())?;
        *bindings = next;
        Ok(())
    }

    /// Handles the binding for workflow.
    fn binding_for(&self, shortcut: &Shortcut) -> Result<Option<RegisteredBinding>, String> {
        self.bindings
            .lock()
            .map_err(|_| "shortcut registry lock poisoned".to_string())
            .map(|bindings| bindings.get(shortcut).cloned())
    }
}

/// Performs the install global shortcut plugin operation.
pub fn install_global_shortcut_plugin<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if event.state() != GlobalShortcutState::Pressed {
                    return;
                }

                let registry = app.state::<ShortcutRegistry>();
                let Ok(Some(binding)) = registry.binding_for(shortcut) else {
                    return;
                };

                let _ = app.emit(TOGGLE_RUN_EVENT, binding.to_payload());
            })
            .build(),
    )
}

/// Performs the apply shortcut bindings operation.
pub fn apply_shortcut_bindings<R: Runtime>(
    app: AppHandle<R>,
    registry: &ShortcutRegistry,
    bindings: Vec<ShortcutBindingRequest>,
) -> Result<ShortcutRegistrationReport, String> {
    let prepared = prepare_bindings(bindings);
    if !prepared.rejected.is_empty() {
        return Ok(ShortcutRegistrationReport {
            registered: registry
                .snapshot()?
                .values()
                .map(RegisteredBinding::to_public)
                .collect(),
            rejected: prepared.rejected,
        });
    }

    let previous = registry.snapshot()?;
    let shortcuts = prepared.bindings.keys().copied().collect::<Vec<_>>();
    let previous_shortcuts = previous.keys().copied().collect::<Vec<_>>();
    let shortcut_manager = app.global_shortcut();

    if let Err(error) = shortcut_manager.unregister_multiple(previous_shortcuts.clone()) {
        return Ok(ShortcutRegistrationReport {
            registered: previous
                .values()
                .map(RegisteredBinding::to_public)
                .collect(),
            rejected: prepared
                .bindings
                .values()
                .map(|binding| {
                    rejected_from_binding(binding, format!("unregister failed: {error}"))
                })
                .collect(),
        });
    }

    if let Err(error) = shortcut_manager.register_multiple(shortcuts.clone()) {
        let _ = shortcut_manager.unregister_multiple(shortcuts);
        let _ = shortcut_manager.register_multiple(previous_shortcuts);

        return Ok(ShortcutRegistrationReport {
            registered: previous
                .values()
                .map(RegisteredBinding::to_public)
                .collect(),
            rejected: prepared
                .bindings
                .values()
                .map(|binding| rejected_from_binding(binding, format!("register failed: {error}")))
                .collect(),
        });
    }

    registry.replace(prepared.bindings.clone())?;

    Ok(ShortcutRegistrationReport {
        registered: prepared
            .bindings
            .values()
            .map(RegisteredBinding::to_public)
            .collect(),
        rejected: Vec::new(),
    })
}

#[derive(Debug)]
struct PreparedBindings {
    bindings: HashMap<Shortcut, RegisteredBinding>,
    rejected: Vec<ShortcutRejectedBinding>,
}

/// Handles the prepare bindings workflow.
fn prepare_bindings(bindings: Vec<ShortcutBindingRequest>) -> PreparedBindings {
    let mut next = HashMap::new();
    let mut rejected = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut seen_shortcuts = HashSet::new();

    for binding in bindings {
        if !binding.enabled || binding.accelerator.trim().is_empty() {
            continue;
        }

        if !seen_ids.insert(binding.id.clone()) {
            rejected.push(rejected_from_request(&binding, "duplicate binding id"));
            continue;
        }

        let shortcut = match parse_shortcut(&binding.accelerator) {
            Ok(shortcut) => shortcut,
            Err(reason) => {
                rejected.push(rejected_from_request(&binding, reason));
                continue;
            }
        };

        if !seen_shortcuts.insert(shortcut) {
            rejected.push(rejected_from_request(&binding, "duplicate accelerator"));
            continue;
        }

        next.insert(
            shortcut,
            RegisteredBinding {
                id: binding.id,
                config_id: binding.config_id,
                accelerator: binding.accelerator.trim().to_string(),
            },
        );
    }

    PreparedBindings {
        bindings: next,
        rejected,
    }
}

/// Returns the parse shortcut result.
fn parse_shortcut(accelerator: &str) -> Result<Shortcut, &'static str> {
    let parts = accelerator
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();

    if parts.is_empty() {
        return Err("empty accelerator");
    }

    let mut mods = Modifiers::empty();
    let mut key = None;

    for part in parts {
        let normalized = part.to_ascii_lowercase();
        match normalized.as_str() {
            "ctrl" | "control" => mods.insert(Modifiers::CONTROL),
            "alt" | "option" | "opt" => mods.insert(Modifiers::ALT),
            "shift" => mods.insert(Modifiers::SHIFT),
            "meta" | "cmd" | "command" | "super" | "win" => mods.insert(Modifiers::SUPER),
            _ => {
                if key.is_some() {
                    return Err("accelerator must contain one main key");
                }
                key = Some(parse_key(&normalized)?);
            }
        }
    }

    let Some(key) = key else {
        return Err("accelerator must contain a main key");
    };

    Ok(Shortcut::new((!mods.is_empty()).then_some(mods), key))
}

/// Returns the parse key result.
fn parse_key(key: &str) -> Result<Code, &'static str> {
    match key {
        "0" => Ok(Code::Digit0),
        "1" => Ok(Code::Digit1),
        "2" => Ok(Code::Digit2),
        "3" => Ok(Code::Digit3),
        "4" => Ok(Code::Digit4),
        "5" => Ok(Code::Digit5),
        "6" => Ok(Code::Digit6),
        "7" => Ok(Code::Digit7),
        "8" => Ok(Code::Digit8),
        "9" => Ok(Code::Digit9),
        "a" => Ok(Code::KeyA),
        "b" => Ok(Code::KeyB),
        "c" => Ok(Code::KeyC),
        "d" => Ok(Code::KeyD),
        "e" => Ok(Code::KeyE),
        "f" => Ok(Code::KeyF),
        "g" => Ok(Code::KeyG),
        "h" => Ok(Code::KeyH),
        "i" => Ok(Code::KeyI),
        "j" => Ok(Code::KeyJ),
        "k" => Ok(Code::KeyK),
        "l" => Ok(Code::KeyL),
        "m" => Ok(Code::KeyM),
        "n" => Ok(Code::KeyN),
        "o" => Ok(Code::KeyO),
        "p" => Ok(Code::KeyP),
        "q" => Ok(Code::KeyQ),
        "r" => Ok(Code::KeyR),
        "s" => Ok(Code::KeyS),
        "t" => Ok(Code::KeyT),
        "u" => Ok(Code::KeyU),
        "v" => Ok(Code::KeyV),
        "w" => Ok(Code::KeyW),
        "x" => Ok(Code::KeyX),
        "y" => Ok(Code::KeyY),
        "z" => Ok(Code::KeyZ),
        "f1" => Ok(Code::F1),
        "f2" => Ok(Code::F2),
        "f3" => Ok(Code::F3),
        "f4" => Ok(Code::F4),
        "f5" => Ok(Code::F5),
        "f6" => Ok(Code::F6),
        "f7" => Ok(Code::F7),
        "f8" => Ok(Code::F8),
        "f9" => Ok(Code::F9),
        "f10" => Ok(Code::F10),
        "f11" => Ok(Code::F11),
        "f12" => Ok(Code::F12),
        "space" => Ok(Code::Space),
        "enter" => Ok(Code::Enter),
        "tab" => Ok(Code::Tab),
        "escape" | "esc" => Ok(Code::Escape),
        "arrowup" | "up" => Ok(Code::ArrowUp),
        "arrowdown" | "down" => Ok(Code::ArrowDown),
        "arrowleft" | "left" => Ok(Code::ArrowLeft),
        "arrowright" | "right" => Ok(Code::ArrowRight),
        "-" => Ok(Code::Minus),
        "=" => Ok(Code::Equal),
        "," => Ok(Code::Comma),
        "." => Ok(Code::Period),
        "/" => Ok(Code::Slash),
        ";" => Ok(Code::Semicolon),
        "'" => Ok(Code::Quote),
        "[" => Ok(Code::BracketLeft),
        "]" => Ok(Code::BracketRight),
        "\\" => Ok(Code::Backslash),
        "`" => Ok(Code::Backquote),
        _ => Err("unsupported main key"),
    }
}

/// Handles the rejected from request workflow.
fn rejected_from_request(
    binding: &ShortcutBindingRequest,
    reason: impl Into<String>,
) -> ShortcutRejectedBinding {
    ShortcutRejectedBinding {
        id: binding.id.clone(),
        config_id: binding.config_id.clone(),
        accelerator: binding.accelerator.clone(),
        reason: reason.into(),
    }
}

/// Handles the rejected from binding workflow.
fn rejected_from_binding(
    binding: &RegisteredBinding,
    reason: impl Into<String>,
) -> ShortcutRejectedBinding {
    ShortcutRejectedBinding {
        id: binding.id.clone(),
        config_id: binding.config_id.clone(),
        accelerator: binding.accelerator.clone(),
        reason: reason.into(),
    }
}

/// Handles the default enabled workflow.
fn default_enabled() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Returns the parses default accelerators result.
    #[test]
    fn parses_default_accelerators() {
        assert!(parse_shortcut("Ctrl+Alt+Shift+1").is_ok());
        assert!(parse_shortcut("Ctrl+Alt+Shift+0").is_ok());
        assert!(parse_shortcut("Ctrl+Alt+Shift+F12").is_ok());
    }

    /// Handles the rejects modifier only shortcuts workflow.
    #[test]
    fn rejects_modifier_only_shortcuts() {
        assert_eq!(
            parse_shortcut("Ctrl+Alt").unwrap_err(),
            "accelerator must contain a main key"
        );
    }

    /// Handles the detects duplicate accelerators workflow.
    #[test]
    fn detects_duplicate_accelerators() {
        let prepared = prepare_bindings(vec![
            ShortcutBindingRequest {
                id: "toggle-run:a".to_string(),
                config_id: "a".to_string(),
                accelerator: "Ctrl+Alt+Shift+1".to_string(),
                enabled: true,
            },
            ShortcutBindingRequest {
                id: "toggle-run:b".to_string(),
                config_id: "b".to_string(),
                accelerator: "ctrl+alt+shift+1".to_string(),
                enabled: true,
            },
        ]);

        assert_eq!(prepared.bindings.len(), 1);
        assert_eq!(prepared.rejected.len(), 1);
        assert_eq!(prepared.rejected[0].reason, "duplicate accelerator");
    }

    /// Handles the ignores disabled or empty bindings workflow.
    #[test]
    fn ignores_disabled_or_empty_bindings() {
        let prepared = prepare_bindings(vec![
            ShortcutBindingRequest {
                id: "toggle-run:a".to_string(),
                config_id: "a".to_string(),
                accelerator: String::new(),
                enabled: true,
            },
            ShortcutBindingRequest {
                id: "toggle-run:b".to_string(),
                config_id: "b".to_string(),
                accelerator: "Ctrl+Alt+Shift+2".to_string(),
                enabled: false,
            },
        ]);

        assert!(prepared.bindings.is_empty());
        assert!(prepared.rejected.is_empty());
    }
}
