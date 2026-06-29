/* ════════════════════════════════════════════════════════════════════
   MIGRACE souborů GitHub → Firebase Storage  (appka Sulice–Želivec)
   Používá firebase-admin (už nainstalovaný v této složce). Žádný gsutil.

   PŘEDPOKLAD: servisní klíč projektu (Firebase konzole → Nastavení projektu →
   Servisní účty → Vygenerovat nový soukromý klíč → uložit jako serviceAccount.json
   DO TÉTO složky; NEcommitovat, je v .gitignore níže).

   Spouštět z této složky (cloud-function/):
     node migrate-storage.js cors                 # nastaví CORS na bucketu
     node migrate-storage.js upload ../overlay overlay   # zkušebně nejdřív overlay (2 soubory)
     node migrate-storage.js url overlay/situace_lines.json   # vypíše ověřovací odkaz
     node migrate-storage.js upload ../photos photos     # Fáze A
     node migrate-storage.js upload ../pdf pdf           # Fáze B
     node migrate-storage.js upload ../drone drone       # Fáze B

   Migrace je PŘÍRŮSTKOVÁ: existující objekt přeskočí (idempotentní), nic nemaže.
   ════════════════════════════════════════════════════════════════════ */

const admin = require('firebase-admin');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

const BUCKET = 'sulice-zelivec-eu';   // EU multi-region bucket (data zůstávají v EU – GDPR)
const KEY    = path.join(__dirname, 'serviceAccount.json');

if (!fs.existsSync(KEY)) {
  console.error('❌ Chybí serviceAccount.json v této složce. Vygeneruj klíč ve Firebase konzoli (Servisní účty).');
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.cert(require(KEY)),
  storageBucket: BUCKET
});
const bucket = admin.storage().bucket();

function mimeOf(p){
  const e = p.toLowerCase().split('.').pop();
  return e === 'pdf'  ? 'application/pdf'
       : e === 'png'  ? 'image/png'
       : e === 'json' ? 'application/json'
       : (e === 'jpg' || e === 'jpeg') ? 'image/jpeg'
       : 'application/octet-stream';
}
function walk(dir, out){
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

async function cmdCors(){
  const cors = JSON.parse(fs.readFileSync(path.join(__dirname, 'cors.json'), 'utf8'));
  await bucket.setCorsConfiguration(cors);
  console.log('✅ CORS nastaven na', BUCKET);
}

async function cmdUpload(localDir, destPrefix){
  localDir = path.resolve(localDir);
  destPrefix = (destPrefix || path.basename(localDir)).replace(/\/+$/,'');
  const files = walk(localDir);
  console.log(`Nahrávám ${files.length} souborů z ${localDir} → ${destPrefix}/ …`);
  let done = 0, skip = 0, fail = 0;
  for (const f of files) {
    const rel  = path.relative(localDir, f).split(path.sep).join('/');
    const dest = destPrefix + '/' + rel;
    const obj  = bucket.file(dest);
    try {
      const [exists] = await obj.exists();
      if (exists) { skip++; continue; }                 // idempotentní – nepřepisuje
      const token = crypto.randomUUID();
      await bucket.upload(f, {
        destination: dest,
        metadata: {
          contentType: mimeOf(f),
          metadata: { firebaseStorageDownloadTokens: token }   // → getDownloadURL funguje hned
        }
      });
      done++;
      if (done % 25 === 0) console.log(`  … ${done} nahráno (${skip} přeskočeno)`);
    } catch(e){ fail++; console.warn('  ⚠️ ', dest, e.message); }
  }
  console.log(`✅ Hotovo: ${done} nahráno, ${skip} přeskočeno (už existovaly), ${fail} chyb.`);
}

async function cmdUrl(storagePath){
  const obj = bucket.file(storagePath);
  const [meta] = await obj.getMetadata();
  const token = meta.metadata && meta.metadata.firebaseStorageDownloadTokens;
  if (!token) { console.log('⚠️ Objekt nemá download token (getDownloadURL ho dogeneruje při prvním přihlášeném volání).'); return; }
  const url = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
  console.log(url);
}

(async () => {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'cors')        await cmdCors();
    else if (cmd === 'upload') await cmdUpload(a, b);
    else if (cmd === 'url')    await cmdUrl(a);
    else console.log('Použití: node migrate-storage.js  cors | upload <localDir> [prefix] | url <storagePath>');
  } catch(e){ console.error('❌', e); process.exit(1); }
  process.exit(0);
})();
