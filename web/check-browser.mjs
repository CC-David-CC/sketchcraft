// Qualify the real packaged WASM and React file menu against the frame protocol.
// The assembled Desktop's separate qualification exercises real account storage.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const [directory] = process.argv.slice(2);
if (!directory) throw Error('Usage: node web/check-browser.mjs /path/to/packaged/editor');
const require = createRequire(process.env.PUPPETEER_PACKAGE || import.meta.url);
const puppeteer = require('puppeteer-core');
const directoryRoot = path.resolve(directory);
const parentPage = `<style>body{margin:0}iframe{width:100vw;height:100vh;border:0}</style><iframe></iframe>
<script>
const frame=document.querySelector('iframe'), records=[];
window.addEventListener('message',event=>{
  if(event.origin===location.origin && event.source===frame.contentWindow)records.push(event.data);
});
window.bridge={
 async take(kind){
   const end=Date.now()+20000;
   while(Date.now()<end){
     const index=records.findIndex(record=>record.type==='sketchcraft:account-'+kind);
     if(index>=0)return records.splice(index,1)[0];
     await new Promise(r=>setTimeout(r,15));
   }throw Error('Timeout waiting for '+kind);
 },
 send(kind,generation,fields){frame.contentWindow.postMessage({...fields,generation,type:'sketchcraft:account-'+kind},location.origin);}
};
frame.src='/app/index.html?host=webos-account';
</script>`;
const server = http.createServer(async (req,res)=>{
  const url = new URL(req.url,'http://localhost');
  if (url.pathname === '/') {res.setHeader('Content-Type','text/html'); res.end(parentPage);return;}
  const file = path.resolve(directoryRoot,'.'+url.pathname.slice(4));
  if (!url.pathname.startsWith('/app/') || !file.startsWith(directoryRoot + '/')) {res.writeHead(404).end();return;}
  try {
    const mime = {'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.woff2':'font/woff2','.svg':'image/svg+xml'};
    res.setHeader('Content-Type',mime[path.extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser = await puppeteer.launch({headless:true,executablePath:process.env.WEBOS_TEST_CHROMIUM || '/snap/chromium/current/usr/lib/chromium-browser/chrome',
    args:['--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-dev-shm-usage']});
  const origin = 'http://127.0.0.1:'+server.address().port;
  const baseline = 'Documents/Sketch.sketchcraft', copy = 'Documents/Copy.sketchcraft';
  let seq = 0;
  async function launch(path, bytes=null, recover=false, expectOpen=true) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.on('pageerror', e=>console.error('Browser exception:',e.message));
    page.on('request',req=>{
      if(req.url().startsWith('http:') && !req.url().startsWith(origin+'/')) throw Error('Unexpected external request '+req.url());
    });
    await page.setViewport({width:1400,height:950});
    await page.goto(origin);
    const take = kind => page.evaluate(async k=>{
      const p=await window.bridge.take(k);
      if (p.bytes) p.bytes=Array.from(new Uint8Array(p.bytes));
      return p;
    },kind);
    const {generation} = await take('ready');
    const send = (kind, fields={})=>page.evaluate((kind,generation,fields)=>{
      if (Array.isArray(fields.bytes)) fields.bytes = new Uint8Array(fields.bytes).buffer;
      window.bridge.send(kind,generation,fields);
    },kind,generation,fields);
    await send('start',{requestId:String(++seq),path,bytes,newSettings:null,importName:null,recover});
    const started = await take('started');
    assert.equal(started.ok,expectOpen,started.message);
    if (!expectOpen) {await context.close();return;}
    const documentId = started.documentId;
    let state=await take('project-state');
    assert.equal(state.dirty,recover);
    const frame = page.frames().find(f=>f.url().includes('/app/'));
    await frame.waitForSelector('.viewport canvas');
    const operation = async (command,args={}, bound=path)=>{
      await send('operation',{requestId:String(++seq),documentId,path:bound,command,args:JSON.stringify(args)});
      const response=await take('operation-result');
      if (response.message) throw Error(response.message);
      return JSON.parse(response.result);
    };
    const inspect=()=>operation('document.inspect');
    const menu=async(label)=>{
      await frame.click('.file-btn');
      await frame.evaluate(label=>{
        const entry=[...document.querySelectorAll('.dropdown button')].find(b=>b.textContent.trim().startsWith(label));
        if (!entry) throw Error('Missing SketchCraft menu item: '+label);
        entry.click();
      },label);
    };
    const settle=async(save,outcome)=>{
      const {ticket,documentId,revision,path:destination}=save;
      await send('save-result',{ticket,documentId,revision,path:destination,outcome});
      const settled=await take('save-settled');
      assert.equal(settled.adopted,outcome==='written');
      if(settled.adopted) path=destination;
      return settled.projectState;
    };
    const capture=async()=>{
      await send('recovery-capture',{requestId:String(++seq),documentId,revision:state.revision});
      const draft=await take('recovery-captured');
      assert.ok(draft.bytes?.length,draft.message);
      return draft.bytes;
    };
    return {context,frame,take,send,operation,inspect,menu,settle,capture,documentId,
      setState: s=>{state=s;}};
  }
  const app=await launch(null);
  assert.equal((await app.inspect()).faces,0);
  await app.frame.evaluate(async () => {
    const {default: initialize, BrowserModel} = await import(new URL("engine/sketchcraft_web.js", document.baseURI));
    await initialize();
    const model = new BrowserModel();
    const run = command => {
      try {
        const reply = JSON.parse(model.execute("ui", JSON.stringify(command)));
        if (!reply.ok) throw Error(reply.error || "Command refused");
        return reply;
      } catch (error) {
        throw Error(`SketchCraft Layout command ${command.cmd}: ${error.message}`);
      }
    };
    const {face} = run({cmd:"rect",from:[0,0,0],to:[4,4,0]});
    run({cmd:"pushpull",face,distance:3});
    const {sheet} = run({cmd:"sheet_add",name:"Plan",paper:"a3"});
    run({cmd:"viewport_add",sheet,view:{type:"plan",cut_z:1.2,floor_z:0},scale:"1:50",rect_mm:[15,15,250,180]});
    run({cmd:"sheet_ir",sheet});
    if (run({cmd:"drafting_status"}).kept !== 1) throw Error("Initial page did not cache its viewport");
    const added = run({cmd:"rect",from:[6,0,0],to:[8,2,0]});
    run({cmd:"pushpull",face:added.face,distance:2});
    if (run({cmd:"drafting_status"}).kept !== 0) throw Error("Model edit did not invalidate the viewport");
    run({cmd:"sheet_ir",sheet});
    if (run({cmd:"drafting_status"}).kept !== 1) throw Error("Page request did not rebuild its viewport");
    model.free();
  });
  const canvas=await app.frame.$('.viewport canvas');
  const bounds=await canvas.boundingBox();
  assert.ok(bounds?.width > 200);
  await app.frame.click('button[title^="Rectangle"]');
  const page=app.frame.page();
  await page.mouse.click(bounds.x+bounds.width*.45, bounds.y+bounds.height*.59);
  await app.send('recovery-capture',{requestId:String(++seq),documentId:app.documentId,revision:'0'});
  const unfinished=await app.take('recovery-captured');
  assert.ok(unfinished.message && !unfinished.bytes,'a partly drawn shape cannot be captured');
  await page.mouse.click(bounds.x+bounds.width*.62, bounds.y+bounds.height*.70);
  await app.frame.waitForFunction(() => document.querySelector('button[title^="Undo"]') != null);
  assert.equal((await app.inspect()).faces,1,'drawing with the native Rectangle tool');
  await assert.rejects(app.operation('edit.undo'), /another caller/);
  await app.frame.click('button[title^="Undo"]');
  assert.equal((await app.inspect()).faces,0);
  const rect=await app.operation('model.rectangle',{from:[0,0,0],to:[4,4,0]});
  assert.ok(rect.face);
  await app.operation('model.pushpull',{face:rect.face,distance:3});
  assert.equal((await app.inspect()).faces,6);
  await assert.rejects(app.operation('document.inspect',{},'/other.sketchcraft'),/active/);
  await app.menu('Save As');
  const dialog=await app.take('dialog');
  assert.equal(dialog.suggested,'Untitled.sketchcraft');
  await app.send('dialog-result',{requestId:dialog.requestId,outcome:'destination',path:baseline});
  const save=await app.take('save');
  assert.equal((await app.settle(save,'written')).dirty,false);
  const reopened=await launch(baseline,save.bytes);
  assert.equal((await reopened.inspect()).faces,6);
  assert.equal((await reopened.inspect()).undoDepth,0);
  await reopened.context.close();
  await app.operation('model.rectangle',{from:[10,10,0],to:[12,12,0]});
  assert.equal((await app.inspect()).faces,7);
  await app.frame.click('button[title^="Undo"]');
  assert.equal((await app.inspect()).faces,6);
  await app.operation('model.rectangle',{from:[20,20,0],to:[22,22,0]});
  await app.menu('Save As');
  const rename=await app.take('dialog');
  await app.send('dialog-result',{requestId:rename.requestId,outcome:'destination',path:copy});
  const as=await app.take('save');
  await app.operation('document.inspect');
  const failed=await app.settle(as,'failed');
  assert.equal(failed.dirty,true);
  await app.menu('Save As');
  const retry=await app.take('dialog');
  await app.send('dialog-result',{requestId:retry.requestId,outcome:'destination',path:copy});
  const savedCopy=await app.take('save');
  const clean = await app.settle(savedCopy,'written');
  assert.equal(clean.dirty,false);
  await app.operation('model.rectangle',{from:[30,30,0],to:[31,31,0]});
  await app.menu('Save ');
  const pending=await app.take('save');
  await app.frame.click('button[title^="Undo"]');
  const changed=await app.settle(pending,'written');
  assert.equal(changed.dirty,true,'edits during write must remain dirty');
  app.setState(changed);
  const recovery=await app.capture();
  const restored=await launch(copy,recovery,true);
  assert.equal((await restored.inspect()).faces,7);
  const before=await restored.inspect();
  await restored.operation('model.rectangle',{from:[40,40,0],to:[44,44,0]});
  await restored.operation('edit.undo');
  assert.equal((await restored.inspect()).faces,before.faces);
  await restored.menu('New');
  const newRequest=await restored.take('dialog');
  assert.equal(newRequest.operation,'new');
  assert.deepEqual(JSON.parse(newRequest.settings),{});
  await restored.send('dialog-result',{requestId:newRequest.requestId,outcome:'opened'});
  await restored.menu('Open');
  const openRequest=await restored.take('dialog');
  assert.equal(openRequest.operation,'open');
  await restored.send('dialog-result',{requestId:openRequest.requestId,outcome:'cancelled'});
  await restored.menu('Save ');
  const review=await restored.take('save');
  const settled=await restored.settle(review,'written');
  const scope={documentId:restored.documentId,revision:settled.revision,dirty:false,unfinishedEdit:false,lease:'review-1'};
  await restored.send('session',{requestId:String(++seq),...scope,operation:'pause'});
  assert.equal((await restored.take('session-result')).ok,true);
  await assert.rejects(restored.operation('model.rectangle',{from:[0,0,0],to:[1,1,0]}),/no longer active/);
  await restored.send('session',{requestId:String(++seq),...scope,operation:'release'});
  assert.equal((await restored.take('session-result')).ok,true);
  assert.equal((await restored.inspect()).faces,before.faces);
  const newer=JSON.parse(Buffer.from(recovery).toString('utf8')); newer.format=999;
  await launch(copy,[...Buffer.from(JSON.stringify(newer))],false,false);
  console.log('PASS native rectangle, push/pull, native Undo, account Save/Save As, acknowledgement, failed write, edits in flight, fresh reopen, scoped operations, recovery and future-format refusal');
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
