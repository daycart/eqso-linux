#!/usr/bin/env node
// Parche VM: resetUsbAudio() — modprobe reload tras aplay para CM108 VirtualBox
// Uso: node vm-patch-usb-reset.mjs
// Archivo objetivo: /opt/eqso-asorapa/artifacts/relay-daemon/dist/main.mjs

import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';

const TARGET = '/opt/eqso-asorapa/artifacts/relay-daemon/dist/main.mjs';
const BACKUP = TARGET + '.bak-pre-usb-reset';

let content = readFileSync(TARGET, 'utf8');

// ── 0. Verificar que no está ya parcheado ──────────────────────────────────
if (content.includes('resetUsbAudio')) {
  console.log('✓ Parche ya aplicado anteriormente (resetUsbAudio encontrado). Sin cambios.');
  process.exit(0);
}

// ── 1. Backup ──────────────────────────────────────────────────────────────
copyFileSync(TARGET, BACKUP);
console.log(`✓ Backup: ${BACKUP}`);

// ── 2. Insertar resetUsbAudio() antes de startRecorder() ──────────────────
const RESET_METHOD = `  resetUsbAudio() {
    return new Promise((resolve) => {
      log2("[audio] USB reset: modprobe -r snd_usb_audio...");
      const unload = spawn2("modprobe", ["-r", "snd_usb_audio"]);
      unload.on("error", (e) => {
        log2("[audio] USB reset: error en modprobe -r: " + e.message);
        resolve();
      });
      unload.on("close", (code) => {
        log2("[audio] USB reset: descargado (code " + code + "), recargando...");
        const load = spawn2("modprobe", ["snd_usb_audio"]);
        load.on("error", (e) => {
          log2("[audio] USB reset: error en modprobe load: " + e.message);
          resolve();
        });
        load.on("close", (code2) => {
          log2("[audio] USB reset: cargado (code " + code2 + "), esperando 1.5s...");
          setTimeout(resolve, 1500);
        });
      });
    });
  }
`;

const MARKER = '  startRecorder() {';
const markerIdx = content.indexOf(MARKER);
if (markerIdx < 0) {
  console.error('ERROR: No se encontró startRecorder() en el archivo. ¿Versión incorrecta?');
  process.exit(1);
}
content = content.slice(0, markerIdx) + RESET_METHOD + content.slice(markerIdx);
console.log('✓ resetUsbAudio() insertado antes de startRecorder()');

// ── 3. Reemplazar 3× setTimeout(startRecorder, 800) → resetUsbAudio().then() ──

const replacements = [
  // Lugar 1: aplay cerrado inesperadamente
  {
    from: 'log2("[audio] Semi-duplex: reanudando arecord en 800ms (aplay cerrado inesperadamente, reset USB CM108)");\n          setTimeout(() => {\n            if (!this.stopping && !this.player && !this.playerStarting)\n              this.startRecorder();\n          }, 800);',
    to:   'log2("[audio] Semi-duplex: reanudando arecord \u2014 reset USB CM108...");\n          this.resetUsbAudio().then(() => {\n            if (!this.stopping && !this.player && !this.playerStarting)\n              this.startRecorder();\n          });',
    label: 'aplay cerrado inesperadamente'
  },
  // Lugar 2: drain player close normal
  {
    from: 'log2("[audio] Semi-duplex: reanudando arecord en 800ms (reset USB CM108)");\n            setTimeout(() => {\n              if (!this.stopping && !this.player && !this.playerStarting)\n                this.startRecorder();\n            }, 800);',
    to:   'log2("[audio] Semi-duplex: reanudando arecord \u2014 reset USB CM108...");\n            this.resetUsbAudio().then(() => {\n              if (!this.stopping && !this.player && !this.playerStarting)\n                this.startRecorder();\n            });',
    label: 'drain player close normal'
  },
  // Lugar 3: player ya cerrado
  {
    from: 'log2("[audio] Semi-duplex: reanudando arecord en 800ms (player ya cerrado, reset USB CM108)");\n      setTimeout(() => {\n        if (!this.stopping && !this.player && !this.playerStarting)\n          this.startRecorder();\n      }, 800);',
    to:   'log2("[audio] Semi-duplex: reanudando arecord \u2014 reset USB CM108...");\n      this.resetUsbAudio().then(() => {\n        if (!this.stopping && !this.player && !this.playerStarting)\n          this.startRecorder();\n      });',
    label: 'player ya cerrado'
  },
];

let ok = 0;
for (const { from, to, label } of replacements) {
  const count = content.split(from).length - 1;
  if (count === 1) {
    content = content.replace(from, to);
    console.log(`✓ Reemplazado: ${label}`);
    ok++;
  } else {
    console.warn(`⚠ No encontrado (${count} ocurrencias): ${label}`);
    console.warn('  Puede que la VM tenga una versión diferente del JS. Revisad manualmente.');
  }
}

if (ok < 3) {
  console.warn(`\n⚠ Solo ${ok}/3 reemplazos realizados. El parche está INCOMPLETO.`);
  console.warn('  Verifique el archivo manualmente o copie dist/main.mjs desde Replit.');
}

// ── 4. Guardar ────────────────────────────────────────────────────────────
writeFileSync(TARGET, content, 'utf8');
console.log(`\n✓ Archivo guardado: ${TARGET}`);

// ── 5. Reiniciar servicio ──────────────────────────────────────────────────
if (ok === 3) {
  console.log('\nReiniciando eqso-relay@CB.service...');
  try {
    execSync('systemctl restart eqso-relay@CB.service', { stdio: 'inherit' });
    console.log('✓ Servicio reiniciado. Monitoreando 5s...');
    execSync('sleep 5 && journalctl -u eqso-relay@CB.service -n 30 --no-pager', { stdio: 'inherit' });
  } catch (e) {
    console.error('ERROR reiniciando servicio:', e.message);
    console.log('Reinicia manualmente: sudo systemctl restart eqso-relay@CB.service');
  }
} else {
  console.log('\nNo se reinicia el servicio — parche incompleto. Revise manualmente.');
}
