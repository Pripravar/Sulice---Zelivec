/* Přenahrání 360° snímků ve vyšší kvalitě (5760) – PŘEPISUJE existující objekty
   (force upload + nový download token), DB záznamy obnoví (path stejná). */
const admin = require('firebase-admin');
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const SA = require('/Users/ondrejsvoboda/Downloads/Sulice, mapa do telefonu/Sulice, mapa do teleofnu/Sulice---Zelivec/cloud-function/serviceAccount.json');
const OUT = '/private/tmp/claude-501/-Users-ondrejsvoboda-Downloads-Sulice--mapa-do-telefonu/2c31c38c-257e-43a6-8055-846d7478aec4/scratchpad/pano_out5760';
const AUTHOR = 'Tomáš Klejna';
admin.initializeApp({ credential: admin.credential.cert(SA), storageBucket:'sulice-zelivec-eu',
  databaseURL:'https://sulice-zelivec-default-rtdb.europe-west1.firebasedatabase.app' });
const bucket = admin.storage().bucket(), db = admin.database();
(async () => {
  const man = JSON.parse(fs.readFileSync(path.join(OUT,'manifest.json'),'utf8'));
  const datum = man.datum, prefix = 'pano360/'+datum+'/';
  const baseTs = Date.parse(datum+'T08:00:00Z');
  let up = 0;
  for (const it of man.items) {
    const dest = prefix+it.name+'.jpg';
    const token = crypto.randomUUID();
    await bucket.upload(path.join(OUT,it.name+'.jpg'), { destination:dest, // přepíše původní
      metadata:{ contentType:'image/jpeg', metadata:{ firebaseStorageDownloadTokens:token } } });
    await db.ref('panorama_360/'+it.name).set({ lat:it.lat, lon:it.lon, path:dest, datum:datum,
      poradi:it.poradi, azimut:it.azimut, author:AUTHOR, ts:baseTs+it.poradi*1000 });
    if(++up % 10 === 0) console.log('  … '+up);
  }
  console.log('✅ Přenahráno '+up+' @5760, DB obnoveno.');
  process.exit(0);
})().catch(e => { console.error('❌', e); process.exit(1); });
