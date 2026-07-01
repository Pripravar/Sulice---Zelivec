/* ════════════════════════════════════════════════════════════════
   CLOUD FUNCTION – odesílání push notifikací
   - Sleduje /notifikace_fronta v Realtime Database
   - Pro každý nový záznam pošle FCM zprávu příjemcům
   - Po odeslání záznam smaže (aby fronta nerostla)

   DEPLOYMENT:
     1. Nainstaluj Node.js (verze 18+) a Firebase CLI:
          npm install -g firebase-tools
     2. V této složce (cloud-function) spusť:
          npm install
          firebase login
          firebase init functions      (vyber existující projekt sulice-zelivec)
          ...ale tento soubor index.js si chraň – pokud Firebase zeptal,
             zda přepsat, řekni N (Ne), nebo prostě překopíruj zpět.
     3. Deploy:
          firebase deploy --only functions

   POŽADAVKY: plán Firebase 'Blaze' (pay-as-you-go), free tier pokryje
   stovky notifikací denně bez nákladů. Stačí jednou zadat platební kartu
   v Firebase Console - dokud nepřekročíš limit, žádné poplatky.
   ════════════════════════════════════════════════════════════════ */

// firebase-functions v6 vyžaduje explicitní /v1 import pro starší API (.ref().onCreate())
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.database();

// Funkce musí běžet ve stejné oblasti jako Realtime DB (europe-west1).
exports.sendTaskNotifications = functions
  .region('europe-west1')
  .database
  .ref('/notifikace_fronta/{id}')
  .onCreate(async (snap, context) => {
    const rec = snap.val();
    if(!rec) return null;

    // Sestavit titulek a tělo zprávy podle typu
    let title = 'Sulice – Želivec';
    let body  = '';
    let recipientUids = [];

    if(rec.typ === 'novy') {
      title = '✅ Nový úkol';
      body = (rec.zadalName || 'Někdo') + ' ti zadal: ' + (rec.title || '');
      recipientUids = (rec.prirazeno || []).map(p => p.uid).filter(Boolean);
    } else if(rec.typ === 'hotovo') {
      title = '🎉 Úkol hotov';
      body = 'Úkol "' + (rec.title || '') + '" byl označen jako hotový.';
      // Posíláme zadavateli (pokud zadavatel != ten, kdo úkol dokončil - tady jsme záměrně laxní)
      if(rec.zadalUid) recipientUids.push(rec.zadalUid);
    } else if(rec.typ === 'komentar') {
      title = '💬 Nový komentář';
      body = 'Komentář k úkolu "' + (rec.title || '') + '"';
      // Posíláme zadavateli i všem přiřazeným
      if(rec.zadalUid) recipientUids.push(rec.zadalUid);
      (rec.prirazeno || []).forEach(p => { if(p.uid) recipientUids.push(p.uid); });
    }

    // Odstranit duplicity
    recipientUids = [...new Set(recipientUids)];

    if(recipientUids.length === 0) {
      console.log('Žádní příjemci, mažu záznam.');
      return snap.ref.remove();
    }

    // Najít FCM tokeny příjemců
    const usersSnap = await db.ref('/uzivatele').once('value');
    const users = usersSnap.val() || {};
    const tokens = [];
    recipientUids.forEach(uid => {
      const u = users[uid];
      if(u && u.fcmToken) tokens.push(u.fcmToken);
    });

    if(tokens.length === 0) {
      console.log('Žádné FCM tokeny u příjemců.');
      return snap.ref.remove();
    }

    // Připravit zprávu
    const message = {
      notification: { title, body },
      data: {
        taskId: rec.taskId || '',
        typ:    rec.typ    || ''
      },
      tokens: tokens
    };

    try {
      const resp = await admin.messaging().sendEachForMulticast(message);
      console.log('FCM odesláno:', resp.successCount, '/', tokens.length);
      // Smazat neplatné tokeny
      const cleanupPromises = [];
      resp.responses.forEach((r, idx) => {
        if(!r.success) {
          const err = r.error;
          const badToken = tokens[idx];
          if(err && (err.code === 'messaging/invalid-registration-token' ||
                     err.code === 'messaging/registration-token-not-registered')) {
            // Najít uživatele, kdo má tento token, a smazat ho
            Object.keys(users).forEach(uid => {
              if(users[uid] && users[uid].fcmToken === badToken) {
                cleanupPromises.push(db.ref('/uzivatele/' + uid + '/fcmToken').remove());
              }
            });
          }
        }
      });
      await Promise.all(cleanupPromises);
    } catch(e) {
      console.error('Chyba odeslání FCM:', e);
    }

    return snap.ref.remove();
  });

/* ════════════════════════════════════════════════════════════════
   HTTPS FUNKCE – upload fotky do GitHubu (token zůstává na serveru)
   - Klient pošle POST { filename, content (base64 JPEG) } + Firebase ID token
   - Funkce ověří přihlášení, validuje jméno souboru a commitne do repa
   - GitHub token je v Secret Manageru, NIKDY v prohlížeči

   NASTAVENÍ TOKENU (jednou):
     firebase functions:secrets:set GITHUB_TOKEN
       → vlož NOVÝ fine-grained PAT (repo Sulice---Zelivec, Contents: Read&Write)
   DEPLOY:
     firebase deploy --only functions
   URL po deployi:
     https://europe-west1-sulice-zelivec.cloudfunctions.net/uploadFoto
   ════════════════════════════════════════════════════════════════ */
const GH_REPO     = 'Pripravar/Sulice---Zelivec';
const GH_BRANCH   = 'main';
const ALLOW_ORIGIN = 'https://pripravar.github.io';

exports.uploadFoto = functions
  .region('europe-west1')
  .runWith({ secrets: ['GITHUB_TOKEN'] })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if(req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if(req.method !== 'POST')    { res.status(405).json({ error: 'Jen POST' }); return; }

    // 1) Ověřit přihlášeného uživatele (Firebase ID token)
    const authHeader = req.get('Authorization') || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if(!idToken) { res.status(401).json({ error: 'Chybí přihlášení' }); return; }
    try {
      await admin.auth().verifyIdToken(idToken);
    } catch(e) {
      res.status(401).json({ error: 'Neplatné přihlášení' }); return;
    }

    // 2) Validovat vstup
    const body = req.body || {};
    const filename = String(body.filename || '');
    const content  = String(body.content  || '');
    // jen bezpečné názvy: písmena, číslice, tečka, podtržítko, pomlčka, volitelně jedna
    // podsložka (např. "standalone/"), končí .jpg/.jpeg/.png. Bez ".." a bez úvodního "/".
    if(!/^([A-Za-z0-9_-]+\/)?[A-Za-z0-9._-]+\.(jpe?g|png)$/i.test(filename)) {
      res.status(400).json({ error: 'Neplatné jméno souboru' }); return;
    }
    if(!content || content.length > 12 * 1024 * 1024) { // ~9 MB binárně
      res.status(400).json({ error: 'Chybí nebo příliš velký obsah' }); return;
    }

    // 3) Commit do GitHubu (token ze Secret Manageru)
    const apiUrl = 'https://api.github.com/repos/' + GH_REPO + '/contents/photos/' + filename;
    try {
      const ghResp = await fetch(apiUrl, {
        method: 'PUT',
        headers: {
          'Authorization': 'token ' + process.env.GITHUB_TOKEN,
          'Content-Type':  'application/json',
          'User-Agent':    'sulice-zelivec-fn'
        },
        body: JSON.stringify({ message: 'Foto: ' + filename, content: content, branch: GH_BRANCH })
      });
      const data = await ghResp.json();
      if(ghResp.ok && data && data.content && data.content.download_url) {
        res.status(200).json({ download_url: data.content.download_url });
      } else {
        console.error('GitHub upload err:', ghResp.status, JSON.stringify(data));
        res.status(502).json({ error: (data && data.message) || 'GitHub upload selhal' });
      }
    } catch(e) {
      console.error('uploadFoto výjimka:', e);
      res.status(500).json({ error: 'Chyba serveru při uploadu' });
    }
  });

/* ════════════════════════════════════════════════════════════════
   HTTPS FUNKCE – upload PDF výkresu do GitHubu (pdf/SO_xxx/...)
   - Klient pošle POST { path, content (base64 PDF) } + Firebase ID token
   - path má tvar "SO_104/nazev-souboru.pdf" (jedna SO podsložka + .pdf)
   - Funkce ověří přihlášení, validuje cestu a commitne do repa do pdf/
   - Stejný GitHub token ze Secret Manageru jako uploadFoto
   URL po deployi:
     https://europe-west1-sulice-zelivec.cloudfunctions.net/uploadVykres
   ════════════════════════════════════════════════════════════════ */
exports.uploadVykres = functions
  .region('europe-west1')
  .runWith({ secrets: ['GITHUB_TOKEN'] })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if(req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if(req.method !== 'POST')    { res.status(405).json({ error: 'Jen POST' }); return; }

    // 1) Ověřit přihlášeného uživatele (Firebase ID token)
    const authHeader = req.get('Authorization') || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if(!idToken) { res.status(401).json({ error: 'Chybí přihlášení' }); return; }
    try {
      await admin.auth().verifyIdToken(idToken);
    } catch(e) {
      res.status(401).json({ error: 'Neplatné přihlášení' }); return;
    }

    // 2) Validovat vstup
    const body = req.body || {};
    const path    = String(body.path    || '');
    const content = String(body.content || '');
    // jen "SO_<čísla>/nazev.pdf": jedna podsložka SO_xxx, bezpečný název, .pdf, bez ".."
    if(!/^SO_[0-9]+\/[A-Za-z0-9._-]+\.pdf$/i.test(path) || path.indexOf('..') !== -1) {
      res.status(400).json({ error: 'Neplatná cesta výkresu' }); return;
    }
    if(!content || content.length > 14 * 1024 * 1024) { // ~10 MB binárně (gen1 limit požadavku)
      res.status(400).json({ error: 'Chybí nebo příliš velký obsah (max ~10 MB)' }); return;
    }

    // 3) Commit do GitHubu (token ze Secret Manageru)
    const apiUrl = 'https://api.github.com/repos/' + GH_REPO + '/contents/pdf/' + path;
    try {
      // Pokud soubor existuje, GitHub vyžaduje sha pro update – zjistíme ho.
      let sha = null;
      try {
        const head = await fetch(apiUrl + '?ref=' + GH_BRANCH, {
          headers: {
            'Authorization': 'token ' + process.env.GITHUB_TOKEN,
            'User-Agent':    'sulice-zelivec-fn'
          }
        });
        if(head.ok) { const hd = await head.json(); if(hd && hd.sha) sha = hd.sha; }
      } catch(_) { /* soubor neexistuje – ok */ }

      const payload = { message: 'Výkres: ' + path, content: content, branch: GH_BRANCH };
      if(sha) payload.sha = sha;
      const ghResp = await fetch(apiUrl, {
        method: 'PUT',
        headers: {
          'Authorization': 'token ' + process.env.GITHUB_TOKEN,
          'Content-Type':  'application/json',
          'User-Agent':    'sulice-zelivec-fn'
        },
        body: JSON.stringify(payload)
      });
      const data = await ghResp.json();
      if(ghResp.ok && data && data.content && data.content.download_url) {
        res.status(200).json({ download_url: data.content.download_url, path: 'pdf/' + path });
      } else {
        console.error('GitHub upload výkresu err:', ghResp.status, JSON.stringify(data));
        res.status(502).json({ error: (data && data.message) || 'GitHub upload selhal' });
      }
    } catch(e) {
      console.error('uploadVykres výjimka:', e);
      res.status(500).json({ error: 'Chyba serveru při uploadu' });
    }
  });

/* ════════════════════════════════════════════════════════════════
   HTTPS FUNKCE – upload fotky z dronu do GitHubu (drone/...)
   - Klient pošle POST { filename, content (base64 JPEG/PNG) } + Firebase ID token
   - filename je jen "nazev.jpg" (bez podsložky), commit do drone/
   - Fotka se NEzmenšuje na 1600 px (kvůli čitelnosti při měření), proto vyšší limit
   - Stejný GitHub token ze Secret Manageru jako uploadFoto/uploadVykres
   URL po deployi:
     https://europe-west1-sulice-zelivec.cloudfunctions.net/uploadDroneFoto
   ════════════════════════════════════════════════════════════════ */
exports.uploadDroneFoto = functions
  .region('europe-west1')
  .runWith({ secrets: ['GITHUB_TOKEN'] })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if(req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if(req.method !== 'POST')    { res.status(405).json({ error: 'Jen POST' }); return; }

    // 1) Ověřit přihlášeného uživatele (Firebase ID token)
    const authHeader = req.get('Authorization') || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if(!idToken) { res.status(401).json({ error: 'Chybí přihlášení' }); return; }
    try {
      await admin.auth().verifyIdToken(idToken);
    } catch(e) {
      res.status(401).json({ error: 'Neplatné přihlášení' }); return;
    }

    // 2) Validovat vstup
    const body = req.body || {};
    const filename = String(body.filename || '');
    const content  = String(body.content  || '');
    // jen bezpečný název bez podsložky, končí .jpg/.jpeg/.png, bez ".."
    if(!/^[A-Za-z0-9._-]+\.(jpe?g|png)$/i.test(filename) || filename.indexOf('..') !== -1) {
      res.status(400).json({ error: 'Neplatné jméno souboru' }); return;
    }
    if(!content || content.length > 14 * 1024 * 1024) { // ~10 MB binárně (gen1 limit požadavku)
      res.status(400).json({ error: 'Chybí nebo příliš velký obsah (max ~10 MB)' }); return;
    }

    // 3) Commit do GitHubu (token ze Secret Manageru)
    const apiUrl = 'https://api.github.com/repos/' + GH_REPO + '/contents/drone/' + filename;
    try {
      let sha = null;
      try {
        const head = await fetch(apiUrl + '?ref=' + GH_BRANCH, {
          headers: {
            'Authorization': 'token ' + process.env.GITHUB_TOKEN,
            'User-Agent':    'sulice-zelivec-fn'
          }
        });
        if(head.ok) { const hd = await head.json(); if(hd && hd.sha) sha = hd.sha; }
      } catch(_) { /* soubor neexistuje – ok */ }

      const payload = { message: 'Drone foto: ' + filename, content: content, branch: GH_BRANCH };
      if(sha) payload.sha = sha;
      const ghResp = await fetch(apiUrl, {
        method: 'PUT',
        headers: {
          'Authorization': 'token ' + process.env.GITHUB_TOKEN,
          'Content-Type':  'application/json',
          'User-Agent':    'sulice-zelivec-fn'
        },
        body: JSON.stringify(payload)
      });
      const data = await ghResp.json();
      if(ghResp.ok && data && data.content && data.content.download_url) {
        res.status(200).json({ download_url: data.content.download_url, path: 'drone/' + filename });
      } else {
        console.error('GitHub upload drone err:', ghResp.status, JSON.stringify(data));
        res.status(502).json({ error: (data && data.message) || 'GitHub upload selhal' });
      }
    } catch(e) {
      console.error('uploadDroneFoto výjimka:', e);
      res.status(500).json({ error: 'Chyba serveru při uploadu' });
    }
  });

/* ════════════════════════════════════════════════════════════════
   HTTPS FUNKCE – SUB nahrání fotky BEZ přihlášení (jen jméno)
   - Externí subdodavatel (SUB) fotí přes appku v „SUB režimu" (žádný Google login).
   - Klient pošle POST { name, so, soList, km, lat, lng, date, time, ts, stamped, original, thumb }
     (obrázky base64; stamped = s razítkem, original = bez, thumb = náhled).
   - Funkce (admin SDK = důvěryhodný zapisovatel) nahraje do EU Storage `standalone/` a zapíše
     do /standalone_photos s příznakem zdroj:'SUB'. Žádná změna Firebase pravidel není potřeba.
   URL po deployi:
     https://europe-west1-sulice-zelivec.cloudfunctions.net/uploadSubFoto
   ════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const SUB_BUCKET = 'sulice-zelivec-eu';
async function _subPut(pathname, b64, contentType) {
  const buf = Buffer.from(b64, 'base64');
  const token = crypto.randomUUID();
  await admin.storage().bucket(SUB_BUCKET).file(pathname).save(buf, {
    resumable: false,
    metadata: { contentType, metadata: { firebaseStorageDownloadTokens: token } }
  });
  // token-odkaz (aby SUB fotku viděl/stáhl bez Firebase přihlášení)
  const url = 'https://firebasestorage.googleapis.com/v0/b/' + SUB_BUCKET + '/o/' +
              encodeURIComponent(pathname) + '?alt=media&token=' + token;
  return { path: pathname, url: url };
}
exports.uploadSubFoto = functions
  .region('europe-west1')
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if(req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if(req.method !== 'POST')    { res.status(405).json({ error: 'Jen POST' }); return; }

    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 60);
    if(!name) { res.status(400).json({ error: 'Chybí jméno' }); return; }
    const stamped  = String(b.stamped  || '');
    const original = String(b.original || '');
    const thumb    = String(b.thumb    || '');
    if(!stamped || stamped.length > 12 * 1024 * 1024) { res.status(400).json({ error: 'Chybí/příliš velká fotka' }); return; }
    if(original.length > 12 * 1024 * 1024 || thumb.length > 3 * 1024 * 1024) { res.status(400).json({ error: 'Příliš velká fotka' }); return; }

    const ts = (typeof b.ts === 'number' && b.ts > 0) ? b.ts : Date.now();
    try {
      const base = 'standalone/foto_' + ts;
      const rStamp = await _subPut(base + '_s.jpg', stamped, 'image/jpeg');
      const rOrig  = original ? await _subPut(base + '_o.jpg', original, 'image/jpeg') : rStamp;
      const rThumb = thumb    ? await _subPut(base + '_t.jpg', thumb,    'image/jpeg') : null;
      const entry = {
        url: rStamp.path, urlStamped: rStamp.path, urlOriginal: rOrig.path, stamped: true,
        so: String(b.so || ''),
        soList: Array.isArray(b.soList) ? b.soList : [],
        km: String(b.km || ''),
        author: name, zdroj: 'SUB', sub: true, uid: '',
        lat: (typeof b.lat === 'number') ? b.lat : null,
        lng: (typeof b.lng === 'number') ? b.lng : null,
        time: String(b.time || new Date(ts).toISOString()),
        date: String(b.date || ''),
        ts: ts
      };
      if(rThumb) entry.thumb = rThumb.path;
      await db.ref('standalone_photos/' + ts).set(entry);
      // Vrať token-odkazy, ať si je SUB uloží u sebe (zobrazení/stažení bez přihlášení).
      res.status(200).json({ ok: true, visible: rStamp.url, thumb: (rThumb ? rThumb.url : rStamp.url), full: rStamp.url });
    } catch(e) {
      console.error('uploadSubFoto výjimka:', e);
      res.status(500).json({ error: 'Upload selhal' });
    }
  });
