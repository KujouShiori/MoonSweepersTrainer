#!/usr/bin/env node
'use strict';

// Moon Sweepers save editor.
// Edits the team wallet, tool container tiers and upgrade tree levels.
// Exit the game first. Every write makes a backup and is read back for verification.

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const readline = require('readline');

const MAGIC = 1296257073;
const SCALE = 10;
const DEFAULT_MONEY = '1000000';

function fail(msg) {
  console.error('\nERROR: ' + msg + '\n');
  process.exit(1);
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function read7(buf, state) {
  let n = 0, shift = 0, b;
  do {
    if (state.o >= buf.length) throw new Error('unexpected end of file');
    b = buf[state.o++];
    n |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return n;
}

function readStr(buf, state) {
  const n = read7(buf, state);
  if (state.o + n > buf.length) throw new Error('unexpected end of file');
  const s = buf.slice(state.o, state.o + n).toString('utf8');
  state.o += n;
  return s;
}

function readI32(buf, state) {
  if (state.o + 4 > buf.length) throw new Error('unexpected end of file');
  const v = buf.readInt32LE(state.o);
  state.o += 4;
  return v;
}

function skip(buf, state, n) {
  if (n < 0 || state.o + n > buf.length) throw new Error('bad field length');
  state.o += n;
}

function readDouble(buf, state) { skip(buf, state, 8); }
function readFloat(buf, state) { skip(buf, state, 4); }
function readBool(buf, state) { skip(buf, state, 1); }

function readDecimal(buf, off) {
  const lo = buf.readUInt32LE(off);
  const mid = buf.readUInt32LE(off + 4);
  const hi = buf.readUInt32LE(off + 8);
  const flags = buf.readUInt32LE(off + 12);
  const scale = (flags >>> 16) & 0xff;
  const negative = (flags >>> 31) & 1;
  const value = (BigInt(hi) << 64n) | (BigInt(mid) << 32n) | BigInt(lo);
  return { value, scale, negative: !!negative };
}

function decimalToScaled(d, scale = SCALE) {
  let v = d.value;
  if (d.scale > scale) v /= 10n ** BigInt(d.scale - scale);
  else if (d.scale < scale) v *= 10n ** BigInt(scale - d.scale);
  return d.negative ? -v : v;
}

function formatScaled(v, scale = SCALE) {
  const neg = v < 0n;
  let s = (neg ? -v : v).toString();
  if (scale > 0) {
    s = s.padStart(scale + 1, '0');
    s = s.slice(0, -scale) + '.' + s.slice(-scale);
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return (neg ? '-' : '') + s;
}

function parseAmount(text) {
  const s = String(text).trim().replace(/[$,\s]/g, '');
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) {
    throw new Error('amount must be a plain number, e.g. 1000000 or 1234.56');
  }
  let frac = m[3] || '';
  if (frac.length > SCALE) throw new Error('at most ' + SCALE + ' decimal places');
  frac = frac.padEnd(SCALE, '0');
  let v = BigInt((m[2] || '0') + frac);
  if (m[1] === '-') v = -v;
  return v;
}

function writeDecimalScaled(buf, off, value, scale = SCALE) {
  if (value < 0n || value >= (1n << 96n)) throw new Error('amount out of range');
  buf.writeUInt32LE(Number(value & 0xffffffffn), off);
  buf.writeUInt32LE(Number((value >> 32n) & 0xffffffffn), off + 4);
  buf.writeUInt32LE(Number((value >> 64n) & 0xffffffffn), off + 8);
  buf.writeUInt32LE((scale << 16) >>> 0, off + 12);
}

class Writer {
  constructor() { this.buf = Buffer.alloc(256); this.o = 0; }
  ensure(n) {
    if (this.o + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.o + n));
    this.buf.copy(next);
    this.buf = next;
  }
  i32(v) { this.ensure(4); this.buf.writeInt32LE(v, this.o); this.o += 4; }
  dbl(v) { this.ensure(8); this.buf.writeDoubleLE(v, this.o); this.o += 8; }
  str(s) {
    const b = Buffer.from(s == null ? '' : String(s), 'utf8');
    this.ensure(10 + b.length);
    let n = b.length;
    while (n >= 0x80) { this.buf[this.o++] = (n & 0x7f) | 0x80; n >>>= 7; }
    this.buf[this.o++] = n;
    b.copy(this.buf, this.o);
    this.o += b.length;
  }
  bytes() { return this.buf.slice(0, this.o); }
}

function loadEnvelope(file) {
  const raw = fs.readFileSync(file);
  if (raw.length < 16) throw new Error('file is too small');
  if (raw.readInt32LE(0) !== MAGIC) throw new Error('not a Moon Sweepers save (MCP1 missing)');
  const length = raw.readInt32LE(4);
  if (length < 0 || length > 600000000) throw new Error('bad payload length');
  const state = { o: 8 };
  const headerHash = readStr(raw, state);
  const payload = zlib.gunzipSync(raw.slice(state.o));
  if (payload.length !== length) throw new Error('payload length mismatch');
  return { raw, payload, headerHash, actualHash: sha(payload) };
}

function saveEnvelope(file, payload) {
  const hash = sha(payload);
  const head = Buffer.alloc(8);
  head.writeInt32LE(MAGIC, 0);
  head.writeInt32LE(payload.length, 4);
  const w = new Writer();
  w.str(hash);
  const gz = zlib.gzipSync(payload, { level: 9 });
  const out = Buffer.concat([head, w.bytes(), gz]);
  const tmp = file + '.trainer-tmp';
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);
}

function checkGameClosed() {
  if (process.platform !== 'win32') return;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq MoonSweepers.exe', '/NH'], { encoding: 'utf8' });
    if (/MoonSweepers\.exe/i.test(out)) fail('Moon Sweepers is running. Quit to desktop, then run again.');
  } catch (_) {}
}

function saveRoot() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(path.dirname(local), 'LocalLow', 'DragDropGames', 'MoonSweepers', 'MoonSessions');
}

function findSaves() {
  const root = saveRoot();
  const saves = [];
  if (!fs.existsSync(root)) return saves;
  for (const slotName of fs.readdirSync(root)) {
    const m = /^slot-(\d+)$/.exec(slotName);
    if (!m) continue;
    const slotDir = path.join(root, slotName);
    if (!fs.statSync(slotDir).isDirectory()) continue;
    for (const world of fs.readdirSync(slotDir)) {
      const file = path.join(slotDir, world, 'session.moon');
      if (!fs.existsSync(file)) continue;
      const st = fs.statSync(file);
      let wallet = null, levels = null;
      try {
        const env = loadEnvelope(file);
        const info = parseSave(env.payload);
        wallet = formatScaled(totalScaled(info.wallets));
        levels = info.upgradeTree.reduce((n, p) => n + p.nodes.length, 0);
      } catch (_) {}
      saves.push({ file, slot: Number(m[1]), world, mtime: st.mtime, wallet, levels });
    }
  }
  saves.sort((a, b) => b.mtime - a.mtime);
  return saves;
}

function printSaves(saves) {
  if (!saves.length) {
    console.log('No save found under:\n  ' + saveRoot());
    return;
  }
  console.log('Saves under ' + saveRoot() + ':');
  saves.forEach((s, i) => {
    console.log('  ' + (i + 1) + ') slot-' + s.slot + '  world ' + s.world.slice(0, 12) + '  wallet $' + (s.wallet || '?') + '  tree nodes ' + (s.levels == null ? '?' : s.levels) + '  ' + s.mtime.toLocaleString());
    console.log('     ' + s.file);
  });
}

function pickSave(opts, interactive) {
  if (opts.file) {
    const file = path.resolve(opts.file);
    if (!fs.existsSync(file)) fail('file not found: ' + file);
    return { file, slot: null, world: path.basename(path.dirname(file)), mtime: fs.statSync(file).mtime, wallet: null };
  }
  let saves = findSaves();
  if (opts.slot !== undefined) saves = saves.filter(s => s.slot === Number(opts.slot));
  if (!saves.length) fail('no save found; start the game once to create one');
  if (interactive) return saves[0];
  if (saves.length > 1) {
    printSaves(saves);
    fail('multiple saves; add --slot N or --file PATH');
  }
  return saves[0];
}

function totalScaled(wallets) {
  return wallets.reduce((sum, w) => sum + decimalToScaled(w.dollars), 0n);
}

function parseArgs(argv) {
  const opts = {};
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') opts.file = argv[++i];
    else if (argv[i] === '--slot') opts.slot = argv[++i];
    else if (argv[i] === '--yes' || argv[i] === '-y') opts.yes = true;
    else words.push(argv[i]);
  }
  return { opts, words };
}

function readDoubleVal(buf, state) {
  if (state.o + 8 > buf.length) throw new Error('unexpected end of file');
  const v = buf.readDoubleLE(state.o);
  state.o += 8;
  return v;
}

function capped(n, max, what) {
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error('bad ' + what + ' count: ' + n);
  return n;
}

// Parses the whole manifest up to the upgrade-tree section.
// Returns wallet offsets plus the container/tree section boundaries.
function parseSave(payload) {
  const s = { o: 0 };
  const version = readI32(payload, s);
  if (version < 19 || version > 35) throw new Error('unsupported save version ' + version + ' (this tool needs 19..35)');
  const identity = readStr(payload, s);
  const seed = readI32(payload, s);
  const settings = readStr(payload, s);
  const regionCount = capped(readI32(payload, s), 2000000, 'region');
  skip(payload, s, regionCount);
  const chunkCount = capped(readI32(payload, s), 24576, 'chunk');
  for (let i = 0; i < chunkCount; i++) {
    readI32(payload, s);
    readStr(payload, s);
    skip(payload, s, capped(readI32(payload, s), 600000000, 'coarse'));
  }

  readI32(payload, s);
  readDouble(payload, s);
  const pileCount = capped(readI32(payload, s), 2000000, 'pile');
  for (let i = 0; i < pileCount; i++) {
    readI32(payload, s);
    readFloat(payload, s); readFloat(payload, s); readFloat(payload, s);
    readDouble(payload, s);
  }
  readDouble(payload, s);
  readBool(payload, s);
  readDouble(payload, s);
  const invCount = capped(readI32(payload, s), 10000, 'inventory');
  for (let i = 0; i < invCount; i++) { readStr(payload, s); readDouble(payload, s); }
  readDouble(payload, s);

  const wallets = [];
  const walletCount = capped(readI32(payload, s), 10000, 'wallet');
  for (let i = 0; i < walletCount; i++) {
    const player = readStr(payload, s);
    const dollarsOff = s.o;
    const dollars = readDecimal(payload, s.o);
    skip(payload, s, 16);
    const pending = readDecimal(payload, s.o);
    skip(payload, s, 16);
    wallets.push({ player, dollarsOff, dollars, pending });
  }

  const upgrades = [];
  const upgradeCount = capped(readI32(payload, s), 10000, 'upgrade player');
  for (let i = 0; i < upgradeCount; i++) {
    const player = readStr(payload, s);
    const inventoryTier = readI32(payload, s);
    const toolCount = capped(readI32(payload, s), 1000, 'tool');
    const tools = [];
    for (let j = 0; j < toolCount; j++) {
      const id = readStr(payload, s);
      const level = readI32(payload, s);
      tools.push({ id, level });
    }
    upgrades.push({ player, inventoryTier, tools });
  }

  readI32(payload, s);
  const canisterCount = capped(readI32(payload, s), 100000, 'canister');
  for (let i = 0; i < canisterCount; i++) {
    readI32(payload, s);
    readStr(payload, s);
    readDouble(payload, s); readDouble(payload, s);
    readFloat(payload, s); readFloat(payload, s); readFloat(payload, s);
    readFloat(payload, s); readFloat(payload, s); readFloat(payload, s);
    if (version >= 11) { readBool(payload, s); readFloat(payload, s); readFloat(payload, s); readFloat(payload, s); readFloat(payload, s); }
  }

  readI32(payload, s);
  const depotCount = capped(readI32(payload, s), 10000, 'depot');
  for (let i = 0; i < depotCount; i++) {
    readI32(payload, s);
    readStr(payload, s);
    readFloat(payload, s); readFloat(payload, s); readFloat(payload, s); readFloat(payload, s);
    readDouble(payload, s);
    const contributors = capped(readI32(payload, s), 10000, 'depot contributor');
    for (let j = 0; j < contributors; j++) { readStr(payload, s); skip(payload, s, 16); }
    if (version >= 10) readI32(payload, s);
  }

  const loadoutCount = capped(readI32(payload, s), 10000, 'loadout');
  for (let i = 0; i < loadoutCount; i++) {
    readStr(payload, s);
    readI32(payload, s);
    const slots = capped(readI32(payload, s), 6, 'loadout slot');
    for (let j = 0; j < slots; j++) readStr(payload, s);
  }

  const vehicleCount = capped(readI32(payload, s), 10000, 'vehicle storage');
  for (let i = 0; i < vehicleCount; i++) { readStr(payload, s); readDouble(payload, s); readDouble(payload, s); }

  readI32(payload, s);
  const conveyorCount = capped(readI32(payload, s), 20000, 'conveyor');
  for (let i = 0; i < conveyorCount; i++) {
    readI32(payload, s);
    readStr(payload, s);
    for (let j = 0; j < 12; j++) readFloat(payload, s);
  }

  const poseCount = capped(readI32(payload, s), depotCount, 'structure pose');
  for (let i = 0; i < poseCount; i++) {
    readI32(payload, s);
    readFloat(payload, s); readFloat(payload, s); readFloat(payload, s); readFloat(payload, s);
    readI32(payload, s);
  }

  readI32(payload, s);
  readI32(payload, s);
  const prefixEnd = s.o;

  const toolContainers = [];
  const tcCount = capped(readI32(payload, s), 10000, 'tool container player');
  for (let i = 0; i < tcCount; i++) {
    const player = readStr(payload, s);
    const loaded = readStr(payload, s);
    const containerCount = capped(readI32(payload, s), 1000, 'tool container');
    const containers = [];
    for (let j = 0; j < containerCount; j++) {
      containers.push({ tool: readStr(payload, s), tier: readI32(payload, s), kilograms: readDoubleVal(payload, s) });
    }
    toolContainers.push({ player, loaded, containers });
  }
  const toolEnd = s.o;

  const upgradeTree = [];
  const treeCount = capped(readI32(payload, s), 10000, 'tree player');
  for (let i = 0; i < treeCount; i++) {
    const player = readStr(payload, s);
    const nodeCount = capped(readI32(payload, s), 1000, 'tree node');
    const nodes = [];
    for (let j = 0; j < nodeCount; j++) nodes.push({ id: readStr(payload, s), level: readI32(payload, s) });
    upgradeTree.push({ player, nodes });
  }
  const treeEnd = s.o;

  return {
    version, identity, seed, settingsLength: settings.length, chunkCount,
    wallets, upgrades, toolContainers, upgradeTree,
    prefixEnd, toolEnd, treeEnd, suffix: payload.slice(treeEnd)
  };
}

function showInfo(file, info) {
  const containers = info.toolContainers.reduce((n, p) => n + p.containers.length, 0);
  const tree = info.upgradeTree.reduce((n, p) => n + p.nodes.length, 0);
  console.log('File:    ' + file);
  console.log('Version: ' + info.version + '  seed: ' + info.seed + '  identity: ' + info.identity);
  console.log('Wallet:  $' + formatScaled(totalScaled(info.wallets)));
  console.log('Read-only: containers ' + containers + ', upgrade tree ' + tree + ' nodes');
}

function applyChange(saveFile, target, assumeYes, label) {
  checkGameClosed();
  const before = loadEnvelope(saveFile);
  const info = parseSave(before.payload);
  const team = info.wallets.find(w => w.player === 'team') || info.wallets[0];
  if (!team) fail('no wallet record in save');
  const oldTotal = totalScaled(info.wallets);
  const payload = Buffer.from(before.payload);
  for (const w of info.wallets) writeDecimalScaled(payload, w.dollarsOff, w === team ? target : 0n);

  console.log('File:   ' + saveFile);
  console.log('Wallet: $' + formatScaled(oldTotal) + '  ->  $' + formatScaled(target));
  if (!assumeYes) fail('refusing to write without --yes (or use interactive mode)');

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17);
  let backup = saveFile + '.trainer-backup-' + stamp;
  for (let n = 2; fs.existsSync(backup); n++) backup = saveFile + '.trainer-backup-' + stamp + '-' + n;
  fs.copyFileSync(saveFile, backup);
  console.log('Backup: ' + backup);

  saveEnvelope(saveFile, payload);

  let after;
  try {
    const env = loadEnvelope(saveFile);
    if (env.headerHash !== env.actualHash) throw new Error('header hash mismatch after write');
    after = parseSave(env.payload);
    if (totalScaled(after.wallets) !== target) throw new Error('wallet total wrong after write');
    const a = Buffer.from(before.payload);
    const b = Buffer.from(env.payload);
    if (a.length !== b.length) throw new Error('payload size changed');
    for (const w of info.wallets) { a.fill(0, w.dollarsOff, w.dollarsOff + 16); b.fill(0, w.dollarsOff, w.dollarsOff + 16); }
    if (!a.equals(b)) throw new Error('other save bytes changed');
  } catch (e) {
    try { fs.copyFileSync(backup, saveFile); } catch (_) {}
    fail('write verification failed, original restored: ' + e.message);
  }

  console.log('OK: wallet $' + formatScaled(totalScaled(after.wallets)));
  console.log('Start the game and load ' + (label || 'the save') + '. The menu summary updates on the next save.');
}

function usage() {
  console.log('MoonTrainer - Moon Sweepers wallet editor\n\n' +
    '  MoonTrainer.exe                          interactive\n' +
    '  MoonTrainer.exe list\n' +
    '  MoonTrainer.exe show   [--slot N | --file PATH]\n' +
    '  MoonTrainer.exe set-money <amount>       [--slot N | --file PATH] [--yes]\n' +
    '  MoonTrainer.exe add-money <amount>       [--slot N | --file PATH] [--yes]\n\n' +
    'Exit the game first. Writes are backed up and verified.');
}

async function interactive() {
  checkGameClosed();
  const saves = findSaves();
  printSaves(saves);
  if (!saves.length) process.exit(1);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(resolve => rl.question(q, resolve));

  let save = saves[0];
  if (saves.length > 1) {
    const answer = (await ask('\nChoose save [1-' + saves.length + '] (default 1): ')).trim();
    const index = answer ? Number(answer) - 1 : 0;
    if (!Number.isInteger(index) || index < 0 || index >= saves.length) { rl.close(); fail('invalid choice'); }
    save = saves[index];
  }

  const info = parseSave(loadEnvelope(save.file).payload);
  const containers = info.toolContainers.reduce((n, p) => n + p.containers.length, 0);
  const tree = info.upgradeTree.reduce((n, p) => n + p.nodes.length, 0);
  console.log('\nCurrent: $' + formatScaled(totalScaled(info.wallets)) + '  containers ' + containers + '  tree ' + tree + ' nodes');

  const input = (await ask('\nNew wallet amount [default ' + DEFAULT_MONEY + ']: ')).trim();
  let target;
  try { target = parseAmount(input || DEFAULT_MONEY); } catch (e) { rl.close(); fail(e.message); }
  const ok = (await ask('Write $' + formatScaled(target) + '? [y/N]: ')).trim().toLowerCase();
  rl.close();
  if (ok !== 'y' && ok !== 'yes') { console.log('Cancelled.'); return; }

  applyChange(save.file, target, true, 'slot-' + save.slot);

  if (process.stdin.isTTY) {
    await new Promise(resolve => {
      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl2.question('\nPress Enter to close...', () => { rl2.close(); resolve(); });
    });
  }
}

async function main() {
  const { opts, words } = parseArgs(process.argv.slice(2));
  if (!words.length) return interactive();
  const cmd = words[0].toLowerCase();

  if (cmd === 'list') { printSaves(findSaves()); return; }

  if (cmd === 'show') {
    const save = pickSave(opts, false);
    showInfo(save.file, parseSave(loadEnvelope(save.file).payload));
    return;
  }

  if (cmd === 'set-money' || cmd === 'add-money') {
    if (words.length < 2) fail('usage: MoonTrainer.exe ' + cmd + ' <amount> [--slot N | --file PATH] [--yes]');
    let amount;
    try { amount = parseAmount(words[1]); } catch (e) { fail(e.message); }
    if (amount < 0n) fail('amount must be zero or positive');
    const save = pickSave(opts, false);
    let target = amount;
    if (cmd === 'add-money') {
      const info = parseSave(loadEnvelope(save.file).payload);
      target = totalScaled(info.wallets) + amount;
    }
    applyChange(save.file, target, opts.yes, save.slot ? 'slot-' + save.slot : null);
    return;
  }

  usage();
}

main().catch(e => fail(e && e.message ? e.message : String(e)));
