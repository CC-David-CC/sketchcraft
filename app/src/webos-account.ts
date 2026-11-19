// One instance per same-origin Desktop frame. Only the parent owns account paths,
// authentication, recovery storage and revision-checked writes.
import type { Reply, Scene } from "./engine";

interface NativeModel {
  open(bytes: Uint8Array): void;
  capture(): Uint8Array;
  revision(): string;
  in_batch(): boolean;
  scene(): string;
  inspect(): string;
  execute(source: string, command: string, plugin?: string): string;
}
type Packet = Record<string, unknown>;
type Dialog = { id: string; saveRevision?: string };
type Save = { ticket: string; documentId: string; revision: string; path: string };
const prefix = "sketchcraft:account-";
const fileLimit = 32 << 20;
const generation = () => [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, "0")).join("");
const validPath = (p: unknown): p is string => typeof p === "string" && new TextEncoder().encode(p).length <= 2048 &&
  !/[\\\u0000-\u001f\u007f-\u009f]/u.test(p) && /\.sketchcraft$/i.test(p) &&
  p.split("/").every(part => part !== "" && part !== "." && part !== "..");
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const coordinate = (v: unknown) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e6;
const point = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(coordinate);
const exact = (o: Packet, ...keys: string[]) => Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));

let model: NativeModel;
let frameGeneration = "";
let documentId = "";
let sequence = 0;
let path: string | null = null;
let savedRevision: string | null = null;
let pending: Save | null = null;
let dialog: Dialog | null = null;
let lease: string | null = null;
let finalized = false;
let agentUpdated = false;
const nextId = () => String(++sequence);
const busy = () => pending !== null || dialog !== null;
const stopped = () => lease !== null || finalized;

let viewportEdit: (() => boolean) | null = null;
const unfinished = () => model.in_batch() || (viewportEdit?.() ?? false);

// The preview of a partly drawn shape lives in the viewport until its final click.
// The account server can acknowledge only geometry already committed to the model.
export function watchViewportEdit(read: () => boolean) {
  viewportEdit = read;
  let previous = read();
  return {
    changed() {
      const next = read();
      if (next !== previous) { previous = next; publish(); }
    },
    dispose() { if (viewportEdit === read) viewportEdit = null; }
  };
}

const state = () => ({
  available: true, documentId, revision: model.revision(), recoveryRevision: model.revision(),
  dirty: model.revision() !== savedRevision, capturable: !unfinished(),
  unfinishedEdit: unfinished(), autosaveEligible: false, operationPending: busy()
});
const post = (kind: string, fields: Packet = {}, bytes?: Uint8Array) => {
  const packet = { ...fields, type: prefix + kind, generation: frameGeneration, ...(bytes ? { bytes: bytes.buffer } : {}) };
  window.parent.postMessage(packet, location.origin, bytes ? [bytes.buffer as ArrayBuffer] : []);
};
function publish() { post("project-state", state()); }
function announce(detail: string) { window.dispatchEvent(new CustomEvent("webos-model-notice", {detail})); }
export function accountPath() { return path; }
export function accountScene(): Scene { return { ...JSON.parse(model.scene()), doc: path ?? "" }; }
export function consumeAgentEdit() { const changed = agentUpdated; agentUpdated = false; return changed; }

export function executeModel(cmd: Packet, source: "ui" | "plugin" | "agent", plugin?: string): Reply {
  if (!model || !documentId || stopped()) return {ok:false, error:"This model is unavailable during session review."};
  const revision = model.revision();
  const result = JSON.parse(model.execute(source, JSON.stringify(cmd), plugin)) as Reply;
  if (model.revision() !== revision) {
    if (source === "agent") agentUpdated = true;
    publish();
  }
  return result;
}

function capture(path: string, kind: string, fields: Packet = {}) {
  if (busy() || stopped() || unfinished() || !validPath(path)) throw Error("The account model is busy or its destination is invalid.");
  const bytes = model.capture();
  const save = {ticket: nextId(), documentId, revision: model.revision(), path};
  pending = save;
  post(kind, {...fields, ...save, outcome:"captured"}, bytes);
  publish();
}

export function fileAction(action: "new" | "open" | "save" | "saveAs") {
  try {
    if (busy() || stopped()) throw Error("Finish the pending account operation first.");
    if (action === "save" && path) return capture(path, "save");
    const saveAs = action === "save" || action === "saveAs";
    dialog = {id: nextId(), saveRevision: saveAs ? model.revision() : undefined};
    post("dialog", {requestId: dialog.id, operation: saveAs ? "save" : action, path: null,
      ...(action === "new" ? {settings:"{}"} : {}),
      ...(saveAs ? {suggested: path?.split("/").pop() ?? "Untitled.sketchcraft"} : {})});
    publish();
  } catch (error) { announce(message(error)); }
}

function operation(packet: Packet) {
  const {requestId} = packet;
  try {
    if (stopped() || packet.documentId !== documentId || packet.path !== path) throw Error("The requested model is no longer active.");
    if (typeof packet.args !== "string" || packet.args.length > 4096) throw Error("Invalid SketchCraft arguments.");
    const args = JSON.parse(packet.args) as Packet;
    if (args === null || typeof args !== "object" || Array.isArray(args)) throw Error("Expected an argument object.");
    let result: unknown;
    if (packet.command === "document.inspect" && exact(args)) result = JSON.parse(model.inspect());
    else {
      if (busy() || unfinished()) throw Error("Finish the current model operation first.");
      let cmd: Packet;
      if (packet.command === "model.rectangle" && exact(args,"from","to") && point(args.from) && point(args.to))
        cmd = {cmd:"rect", ...args};
      else if (packet.command === "model.pushpull" && exact(args,"face","distance") && Number.isSafeInteger(args.face) &&
               Number(args.face) > 0 && Number(args.face) <= 0xffffffff && coordinate(args.distance) && args.distance !== 0)
        cmd = {cmd:"pushpull", ...args};
      else if (packet.command === "edit.undo" && exact(args)) cmd = {cmd:"undo"};
      else throw Error("Unsupported model command or arguments.");
      const reply = executeModel(cmd, "agent");
      if (!reply.ok) throw Error(reply.error);
      result = reply;
    }
    post("operation-result", {requestId, documentId:packet.documentId, result:JSON.stringify(result)});
  } catch (e) { post("operation-result", {requestId, documentId:packet.documentId, message:message(e)}); }
}

function receive(kind: string, packet: Packet) {
  const {requestId, revision} = packet;
  if (kind === "save-result") {
    const save = pending;
    if (!save || !Object.entries(save).every(([key,value]) => packet[key] === value) ||
        !["written","failed","unknown"].includes(String(packet.outcome))) return;
    const adopted = packet.outcome === "written";
    pending = null;
    if (adopted) {
      path = save.path;
      savedRevision = save.revision;
      window.dispatchEvent(new Event("webos-model-path"));
      announce("Saved " + path.split("/").pop());
    } else announce(String(packet.message || "The account save was not confirmed."));
    post("save-settled", {...save,adopted,projectState:state()});
    publish();
    return;
  }
  if (typeof requestId !== "string" || !requestId || requestId.length > 36) return;
  const targets = packet.documentId === documentId && revision === model.revision();
  switch (kind) {
    case "dialog-result": {
      if (dialog?.id !== requestId) return;
      const reviewed = dialog.saveRevision;
      dialog = null;
      try {
        if (packet.outcome === "destination") {
          if (reviewed !== model.revision() || !validPath(packet.path)) throw Error("Model or destination changed before save.");
          capture(packet.path, "save");
        } else if (packet.outcome === "failed") announce(String(packet.message || "The account dialog failed."));
      } catch (e) { announce(message(e)); }
      publish();
      break;
    }
    case "recovery-capture": {
      const reply = {requestId, documentId:packet.documentId, revision};
      try {
        if (!targets || stopped() || unfinished()) throw Error("The model changed before recovery capture.");
        post("recovery-captured", reply, model.capture());
      } catch (e) { post("recovery-captured", {...reply, message:message(e)}); }
      break;
    }
    case "session-save": {
      const reply = {requestId, documentId:packet.documentId, reviewedRevision:revision, path:packet.path};
      try {
        if (!targets || busy() || stopped() || unfinished() || !validPath(packet.path)) {
          post("session-save-result", {...reply,outcome:"busy"}); return;
        }
        capture(packet.path,"session-save-result",reply);
      } catch (e) { post("session-save-result", {...reply,outcome:"failed",message:message(e)}); }
      break;
    }
    case "session": {
      const id = packet.lease;
      let ok = false;
      if (typeof id === "string" && id.length > 0 && id.length <= 64) {
        if (packet.operation === "pause" && !stopped() && !busy() && targets && !unfinished() &&
            packet.unfinishedEdit === false && packet.dirty === state().dirty) { lease = id; ok = true; }
        if ((packet.operation === "release" || packet.operation === "finalize") && lease === id) {
          finalized = packet.operation === "finalize"; lease = null; ok = true;
        }
      }
      post("session-result", {requestId, lease:id, operation:packet.operation, ok});
      break;
    }
    case "operation": operation(packet); break;
  }
}

export async function startAccount() {
  if (window.parent === window || location.origin === "null" || window.parent.location.origin !== location.origin)
    throw Error("Open SketchCraft from the WebOS Desktop.");
  frameGeneration = generation();
  try {
    const url = new URL("engine/sketchcraft_web.js", document.baseURI);
    const wasm = await import(/* @vite-ignore */ url.href);
    await wasm.default();
    model = new wasm.BrowserModel();
  } catch (e) { post("failed",{message:message(e)}); throw e; }
  return new Promise<void>((resolve,reject) => {
    let openFailed = false;
    const timeout = window.setTimeout(() => {
      openFailed = true;
      reject(Error("WebOS did not open the model."));
    }, 120000);
    window.addEventListener("message", event => {
      const p = event.data;
      if (openFailed || event.source !== window.parent || event.origin !== location.origin || p?.generation !== frameGeneration ||
          typeof p.type !== "string" || !p.type.startsWith(prefix)) return;
      const kind = p.type.slice(prefix.length);
      if (kind !== "start") { if (documentId) receive(kind, p); return; }
      if (documentId || typeof p.requestId !== "string" || p.requestId.length > 36) return;
      clearTimeout(timeout);
      try {
        if ((p.path !== null && !validPath(p.path)) || typeof p.recover !== "boolean" ||
            (p.path && p.bytes === null) || p.importName || (p.newSettings != null && p.newSettings !== "{}")) throw Error("Unsupported SketchCraft open request.");
        if (p.bytes !== null) {
          if (!(p.bytes instanceof ArrayBuffer) || !p.bytes.byteLength || p.bytes.byteLength > fileLimit)
            throw Error("Invalid SketchCraft model size.");
          model.open(new Uint8Array(p.bytes));
        }
        documentId = String(crypto.getRandomValues(new BigUint64Array(1))[0] || 1n);
        savedRevision = p.recover ? null : model.revision();
        path = p.path;
        post("started",{requestId:p.requestId,documentId,revision:model.revision(),path,ok:true});
        publish();
        resolve();
      } catch (e) {
        openFailed = true;
        post("started",{requestId:p.requestId,ok:false,message:message(e)});
        reject(e);
      }
    });
    post("ready");
  });
}
