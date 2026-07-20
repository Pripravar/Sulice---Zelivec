/* Jednorázový seed: nahraje zmenšené 360° snímky do EU Storage (sulice-zelivec-eu)
   a založí záznamy do /panorama_360 v Realtime DB. Idempotentní (přeskočí existující).
   Spouštět z cloud-function/:  node seed-pano360.js
   Vyžaduje serviceAccount.json (už tady je) + manifest.json + zmenšené .jpg. */
const admin  = require('firebase-admin');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const BUCKET = 'sulice-zelivec-eu';
const DBURL  = 'https://sulice-zelivec-default-rtdb.europe-west1.firebasedatabase.app';
const OUT    = '/private/tmp/claude-501/-Users-ondrejsvoboda-Downloads-Sulice--mapa-do-telefonu/2c31c38c-257e-43a6-8055-846d7478aec4/scratchpad/pano_out';
const AUTHOR = 'Tomáš Klejna';

admin.initializeApp({
  credential: admin.credential.cert(require(path.join(__dirname, 'serviceAccount.json'))),
  storageBucket: BUCKET,
  databaseURL: DBURL
});
const bucket = admin.storage().bucket();
const db     = admin.database();

(async () => {
  const man = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
  const datum = man.datum;                     // 2026-07-18
  const prefix = 'pano360/' + datum + '/';
  let up = 0, skip = 0, dbw = 0;
  const baseTs = Date.parse(datum + 'T08:00:00Z');   // stabilní ts, ať pořadí drží

  for (const it of man.items) {
    const local = path.join(OUT, it.name + '.jpg');
    const dest  = prefix + it.name + '.jpg';
    const obj   = bucket.file(dest);
    const [exists] = await obj.exists();
    if (exists) { skip++; }
    else {
      const token = crypto.randomUUID();
      await bucket.upload(local, {
        destination: dest,
        metadata: { contentType: 'image/jpeg',
          metadata: { firebaseStorageDownloadTokens: token } }
      });
      up++;
      if (up % 10 === 0) console.log('  … nahráno ' + up);
    }
    // DB záznam (klíč = název souboru → idempotentní)
    await db.ref('panorama_360/' + it.name).set({
      lat: it.lat, lon: it.lon, path: dest, datum: datum,
      poradi: it.poradi, azimut: it.azimut, author: AUTHOR,
      ts: baseTs + it.poradi * 1000
    });
    dbw++;
  }
  console.log('✅ Hotovo: nahráno ' + up + ', přeskočeno ' + skip + ', DB záznamů ' + dbw + ' → /panorama_360');
  process.exit(0);
})().catch(e => { console.error('❌', e); process.exit(1); });
