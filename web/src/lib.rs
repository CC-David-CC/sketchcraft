//! The account editor owns one native geometry engine per browser window.
use serde_json::{json, Value};
use sketchcraft::{
    format,
    policy::{self, Caller, Workspace},
    scene, Engine,
};
use wasm_bindgen::prelude::*;

const MAX_FILE: usize = 32 << 20;

#[wasm_bindgen]
pub struct BrowserModel {
    engine: Engine,
}

#[wasm_bindgen]
impl BrowserModel {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let mut engine = Engine::new();
        engine.undo_budget = 32 << 20;
        Self { engine }
    }

    pub fn open(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() || bytes.len() > MAX_FILE {
            return Err("SketchCraft account models must fit within 32 MiB.".into());
        }
        if let Some(newer) = format::check(bytes) {
            return Err(format!("This account model needs a newer SketchCraft: {}. The original file was left intact.", newer.reasons.join("; ")));
        }
        let model =
            serde_json::from_slice(bytes).map_err(|e| format!("Invalid SketchCraft model: {e}"))?;
        let mut next = Engine::from_model(model).map_err(|e| e.to_string())?;
        if next.oversize || next.model.size_estimate() > MAX_FILE {
            return Err("This model exceeds the browser geometry budget.".into());
        }
        next.undo_budget = self.engine.undo_budget;
        self.engine = next;
        Ok(())
    }

    pub fn capture(&self) -> Result<Vec<u8>, String> {
        if self.engine.in_batch() {
            return Err("Finish the current model edit before saving.".into());
        }
        let bytes = format::to_vec(&self.engine.model).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_FILE {
            return Err("This model exceeds the 32 MiB account editor limit.".into());
        }
        Ok(bytes)
    }

    pub fn revision(&self) -> String {
        self.engine.revision().to_string()
    }
    pub fn in_batch(&self) -> bool {
        self.engine.in_batch()
    }

    pub fn scene(&self) -> String {
        let mut result = scene::build(&self.engine.model, self.engine.ctx);
        result["undo_origin"] = json!(self.engine.undo_origin());
        result["redo_origin"] = json!(self.engine.redo_origin());
        result.to_string()
    }

    pub fn inspect(&self) -> String {
        let m = &self.engine.model;
        json!({"faces":m.faces.len(),"edges":m.edges.len(),"vertices":m.vertices.len(),
            "undoDepth": self.engine.undo_depth(), "undoOrigin": self.engine.undo_origin()})
        .to_string()
    }

    pub fn execute(&mut self, source: &str, command: &str, plugin: Option<String>) -> String {
        let fail = |message| json!({"ok":false,"error":message}).to_string();
        let Ok(mut value) = serde_json::from_str::<Value>(command) else {
            return fail("Invalid SketchCraft command.");
        };
        let name = value["cmd"].as_str().unwrap_or_default();
        // Only model operations reach this engine. Even a native UI tool that can
        // take an optional export path must pass the plugin policy's path checks.
        let history = matches!(name, "undo" | "redo");
        if !history && policy::vet(&Caller::Plugin, &mut value).is_err() {
            return fail("This command requires the standalone SketchCraft application.");
        }
        let caller = match source {
            "ui" => Caller::Ui,
            "plugin" if !history => Caller::Plugin,
            "agent" if matches!(value["cmd"].as_str(), Some("rect" | "pushpull" | "undo")) => {
                if history && self.engine.undo_origin() != Some("an agent") {
                    return fail("The most recent edit belongs to another caller.");
                }
                Caller::Mcp(Workspace::at("/webos-model"))
            }
            _ => return fail("Unsupported SketchCraft caller or operation."),
        };
        self.engine
            .exec_value_as_from(&caller, value, plugin.as_deref())
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(model: &mut BrowserModel, source: &str, cmd: Value) -> Value {
        serde_json::from_str(&model.execute(source, &cmd.to_string(), None)).unwrap()
    }

    #[test]
    fn account_model_uses_native_geometry_and_history() {
        let mut model = BrowserModel::new();
        let face = run(
            &mut model,
            "ui",
            json!({"cmd":"rect","from":[0,0,0],"to":[4,4,0]}),
        )["face"]
            .clone();
        assert!(face.is_number());
        assert_eq!(run(&mut model, "agent", json!({"cmd":"undo"}))["ok"], false);
        assert_eq!(
            run(
                &mut model,
                "agent",
                json!({"cmd":"pushpull","face":face,"distance":3})
            )["ok"],
            true
        );
        let bytes = model.capture().unwrap();
        assert_eq!(model.engine.model.faces.len(), 6);
        assert_eq!(model.engine.undo_origin(), Some("an agent"));
        assert_eq!(run(&mut model, "ui", json!({"cmd":"undo"}))["ok"], true);
        assert_eq!(model.engine.model.faces.len(), 1);
        model.open(&bytes).unwrap();
        assert_eq!(model.engine.model.faces.len(), 6);
        assert_eq!(model.engine.undo_depth(), 0);
    }

    #[test]
    fn refused_open_keeps_the_current_model_and_plugins_only_edit_geometry() {
        let mut model = BrowserModel::new();
        let cmd = json!({"cmd":"rect","from":[0,0,0],"to":[2,2,0]});
        assert_eq!(run(&mut model, "plugin", cmd)["ok"], true);
        let previous = model.capture().unwrap();
        for invalid in [
            b"{".as_slice(),
            br#"{"format":999}"#,
            br#"{"newerFeature":true}"#,
        ] {
            assert!(model.open(invalid).is_err());
            assert_eq!(model.capture().unwrap(), previous);
        }
        for cmd in [
            json!({"cmd":"undo"}),
            json!({"cmd":"open","path":"project"}),
            json!({"cmd":"report","path":"report.csv"}),
        ] {
            assert_eq!(run(&mut model, "plugin", cmd)["ok"], false);
        }
        assert_eq!(
            run(
                &mut model,
                "ui",
                json!({"cmd":"report","path":"report.csv"})
            )["ok"],
            false
        );
    }
}
