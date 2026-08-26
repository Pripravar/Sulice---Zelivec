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
      // Když je v komentáři @zmínka, ukaž rovnou text komentáře (kdo a co); jinak obecné.
      body = rec.mentionText
        ? ((rec.mentionBy ? (rec.mentionBy + ': ') : '') + rec.mentionText)
        : ('Komentář k úkolu "' + (rec.title || '') + '"');
      // Posíláme zadavateli, všem přiřazeným a navíc @zmíněným (i když přiřazení nejsou).
      if(rec.zadalUid) recipientUids.push(rec.zadalUid);
      (rec.prirazeno || []).forEach(p => { if(p.uid) recipientUids.push(p.uid); });
      if(Array.isArray(rec.mentions)) rec.mentions.forEach(uid => { if(uid) recipientUids.push(uid); });
    } else if(rec.typ === 'foto_komentar') {
      title = '💬 Komentář k fotce';
      body = (rec.zadalName || 'Někdo') + ': ' + (rec.komentText || '') + (rec.label ? (' (' + rec.label + ')') : '');
      // Příjemci přijdou přímo v záznamu (autor fotky + dřívější komentující, bez pisatele)
      recipientUids = (rec.recipientUids || []).filter(Boolean);
    }

    // PRIORITA řídí, JESTLI a JAK se push pošle:
    //   nizka  = tiše → u nového úkolu žádný push (jen v aplikaci)
    //   normalni = běžné upozornění na telefon
    //   vysoka = důraznější (heads-up, zůstane dokud ho nezavřeš)
    const priorita = rec.priorita || 'normalni';
    if(rec.typ === 'novy' && priorita === 'nizka') {
      console.log('Nízká priorita – push se neposílá, jen v aplikaci.');
      return snap.ref.remove();
    }

    // Odstranit duplicity
    // typ:'chat' – zpráva v interním chatu; příjemci = členové kanálu (bez pisatele), přijdou v záznamu
    if(rec.typ === 'chat') {
      title = '💬 ' + (rec.kanalNazev || 'Chat');
      body = (rec.zadalName || 'Někdo') + ': ' + (rec.komentText || '');
      recipientUids = (rec.recipientUids || []).filter(Boolean);
    }

    if(rec.typ === 'zminka') {
      title = '💬 Označení' + (rec.label ? (' – ' + rec.label) : '');
      body = (rec.zadalName || 'Někdo') + ': ' + (rec.komentText || '');
      recipientUids = (rec.recipientUids || []).filter(Boolean);
    }

    recipientUids = [...new Set(recipientUids)];

    if(recipientUids.length === 0) {
      console.log('Žádní příjemci, mažu záznam.');
      return snap.ref.remove();
    }

    // Najít FCM tokeny příjemců
    const usersSnap = await db.ref('/uzivatele').once('value');
    const users = usersSnap.val() || {};
    if(rec.typ === 'chat' && rec.kanalId){ recipientUids = recipientUids.filter(uid => !(users[uid] && users[uid].chatMute && users[uid].chatMute[rec.kanalId] === true)); }
    const rawTokens = [];
    recipientUids.forEach(uid => {
      const u = users[uid];
      if(!u) return;
      if(u.fcmToken) rawTokens.push(u.fcmToken);
      if(u.fcmTokens) Object.keys(u.fcmTokens).forEach(k => { if(u.fcmTokens[k]) rawTokens.push(u.fcmTokens[k]); });
    });
    const tokens = [...new Set(rawTokens)];   // per-zařízení, bez duplicit

    if(tokens.length === 0) {
      console.log('Žádné FCM tokeny u příjemců.');
      return snap.ref.remove();
    }

    // Připravit zprávu (vysoká priorita = důraznější doručení napříč platformami)
    const isHigh = priorita === 'vysoka';
    const message = {
      notification: { title, body },
      data: {
        taskId:   rec.taskId  || '',
        kanalId:  rec.kanalId || '',
        fotoKey:  rec.fotoKey || '',
        typ:      rec.typ     || '',
        priorita: priorita
      },
      android: {
        priority: isHigh ? 'high' : 'normal',
        notification: { priority: isHigh ? 'max' : 'default', defaultSound: true }
      },
      apns: {
        headers: { 'apns-priority': isHigh ? '10' : '5' },
        payload: { aps: { sound: 'default', 'interruption-level': isHigh ? 'time-sensitive' : 'active' } }
      },
      webpush: {
        headers: { Urgency: isHigh ? 'high' : 'normal' },
        notification: { requireInteraction: isHigh }   // vysoká zůstane, dokud ji nezavřeš
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
              const u = users[uid]; if(!u) return;
              if(u.fcmToken === badToken) cleanupPromises.push(db.ref('/uzivatele/' + uid + '/fcmToken').remove());
              if(u.fcmTokens) Object.keys(u.fcmTokens).forEach(k => { if(u.fcmTokens[k] === badToken) cleanupPromises.push(db.ref('/uzivatele/' + uid + '/fcmTokens/' + k).remove()); });
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

/* ════════════════════════════════════════════════════════════════
   listSubFotos – vrátí VŠECHNY SUB fotky s token-odkazy (bez přihlášení).
   SUB nemá Firebase auth → getDownloadURL na klientu by selhal. Tahle funkce
   (admin SDK = důvěryhodná) přečte /standalone_photos, vyfiltruje SUB záznamy
   a k uloženým CESTÁM dohledá download-token ze Storage metadat → poskládá
   token-URL, které SUB <img>/stažení zvládne bez auth. Token URL se NIKAM
   neukládají (nejdou do veřejně čitelné DB) – vydají se jen na dotaz.
   ════════════════════════════════════════════════════════════════ */
exports.listSubFotos = functions
  .region('europe-west1')
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if(req.method === 'OPTIONS') { res.status(204).send(''); return; }
    try {
      const snap = await db.ref('standalone_photos').once('value');
      const all = snap.val() || {};
      const bucket = admin.storage().bucket(SUB_BUCKET);
      const cache = {};
      async function toUrl(p) {
        if(!p) return null;
        if(cache[p] !== undefined) return cache[p];
        try {
          const [md] = await bucket.file(p).getMetadata();
          const raw = md && md.metadata && md.metadata.firebaseStorageDownloadTokens;
          if(!raw) { cache[p] = null; return null; }
          const tok = String(raw).split(',')[0];
          const url = 'https://firebasestorage.googleapis.com/v0/b/' + SUB_BUCKET + '/o/' +
                      encodeURIComponent(p) + '?alt=media&token=' + tok;
          cache[p] = url; return url;
        } catch(_) { cache[p] = null; return null; }
      }
      const keys = Object.keys(all).filter(function(k){ const e = all[k]; return e && (e.sub === true || e.zdroj === 'SUB'); });
      const photos = [];
      for(const k of keys) {
        const e = all[k];
        const full  = await toUrl(e.urlStamped || e.url);
        const thumb = (await toUrl(e.thumb)) || full;
        if(!full && !thumb) continue;
        photos.push({
          ts: e.ts || Number(k),
          so: e.so || '', soList: Array.isArray(e.soList) ? e.soList : [],
          km: e.km || '', date: e.date || '', author: e.author || '',
          lat: (typeof e.lat === 'number') ? e.lat : null,
          lng: (typeof e.lng === 'number') ? e.lng : null,
          thumb: thumb, full: full
        });
      }
      photos.sort(function(a,b){ return (b.ts||0) - (a.ts||0); });
      res.status(200).json({ ok: true, photos: photos });
    } catch(e) {
      console.error('listSubFotos výjimka:', e);
      res.status(500).json({ error: 'Načtení selhalo' });
    }
  });

/* ════════════════════════════════════════════════════════════════
   tagFoto – AI popis obsahu fotky (Claude Haiku vision) → klíčová slova.
   Umožní v galerii hledat podle TOHO, CO JE NA FOTCE (finišer, válec, roura…),
   ne jen podle SO/km/data. Přečte fotku ze Storage, pošle ji Claude Haiku,
   uloží česká klíčová slova do /standalone_photos/{ts}/tags.
   Idempotentní: fotku s tags přeskočí (pokud force!==true) → hlídá náklady.
   Secret ANTHROPIC_API_KEY: firebase functions:secrets:set ANTHROPIC_API_KEY
   ════════════════════════════════════════════════════════════════ */
const TAG_PROMPT =
  'Jsi asistent na stavbě silnice. Podívej se na fotografii a vypiš 5–12 českých ' +
  'klíčových slov (podstatná jména, malá písmena, oddělená čárkou) popisujících, CO je na ní vidět: ' +
  'stroje, prvky, materiály, činnosti, stav. Např.: finišer, asfalt, válec, obrubník, výkop, kanalizace, ' +
  'roura, šachta, bednění, výztuž, dělník, nákladní auto, bagr, silnice, značení, mostek, příkop. ' +
  'Vrať POUZE klíčová slova oddělená čárkou, nic jiného, žádné věty.';

async function _imgBase64(imgRef) {
  // imgRef je buď cesta ve Storage (standalone/foto_..._t.jpg) nebo plná http URL (staré fotky na GitHubu).
  if(/^https?:\/\//.test(imgRef)) {
    const r = await fetch(imgRef);
    if(!r.ok) throw new Error('fetch obrázku ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.toString('base64');
  }
  const [buf] = await admin.storage().bucket(SUB_BUCKET).file(imgRef).download();
  return buf.toString('base64');
}

exports.tagFoto = functions
  .region('europe-west1')
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if(req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if(req.method !== 'POST')    { res.status(405).json({ error: 'Jen POST' }); return; }
    try {
      const b = req.body || {};
      const ts = String(b.ts || '').trim();
      if(!ts) { res.status(400).json({ error: 'Chybí ts' }); return; }
      const snap = await db.ref('standalone_photos/' + ts).once('value');
      const e = snap.val();
      if(!e) { res.status(404).json({ error: 'Fotka nenalezena' }); return; }
      if(e.tags && b.force !== true) { res.status(200).json({ ok: true, skipped: true, tags: e.tags }); return; }
      // Pošli pořádné rozlišení kvůli přesnějšímu rozpoznání – Claude si velký obrázek
      // sám zmenší na své straně, takže cena se nezvedne (účtuje se strop tokenů, ne plné px).
      // Preferuj ORIGINÁL (bez razítka), fallback stamped → visible → thumb.
      const imgRef = e.urlOriginal || e.urlStamped || e.url || e.thumb;
      if(!imgRef) { res.status(400).json({ error: 'Fotka bez obrázku' }); return; }
      const data = await _imgBase64(imgRef);
      const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 80,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data } },
              { type: 'text', text: TAG_PROMPT }
            ]
          }]
        })
      });
      if(!aiResp.ok) {
        const errTxt = await aiResp.text();
        console.error('Claude API chyba', aiResp.status, errTxt);
        res.status(502).json({ error: 'AI popis selhal (' + aiResp.status + ')' });
        return;
      }
      const ai = await aiResp.json();
      let tags = '';
      if(ai && Array.isArray(ai.content)) {
        const t = ai.content.find(function(c){ return c.type === 'text'; });
        if(t) tags = String(t.text || '').trim().toLowerCase();
      }
      tags = tags.replace(/[\r\n]+/g, ' ').replace(/\.$/, '').slice(0, 300);
      if(!tags) { res.status(502).json({ error: 'AI vrátila prázdný popis' }); return; }
      await db.ref('standalone_photos/' + ts).update({ tags: tags, tagsAt: Date.now() });
      res.status(200).json({ ok: true, tags: tags });
    } catch(err) {
      console.error('tagFoto výjimka:', err);
      res.status(500).json({ error: 'Tagování selhalo' });
    }
  });

/* ════════════════════════════════════════════════════════════════
   checkReminders – naplánovaná (každých 15 min) kontrola připomínek úkolů.
   Úkol může mít pripominka: {typ:'cas', at, rep} | {typ:'termin', before}.
   Když je připomínka splatná, pošle push zadateli + přiřazeným. sentAt hlídá,
   ať se nepošle dvakrát; u opakování posune 'at' na další den/týden.
   (typ 'geo' se řeší v aplikaci na telefonu, ne tady.)
   POŽADAVKY: Blaze + zapnuté Cloud Scheduler & Pub/Sub API (deploy nabídne).
   ════════════════════════════════════════════════════════════════ */
async function _sendPush(uids, title, body, high) {
  uids = [...new Set((uids || []).filter(Boolean))];
  if(!uids.length) return;
  const usersSnap = await db.ref('/uzivatele').once('value');
  const users = usersSnap.val() || {};
  const _raw = [];
  uids.forEach(uid => { const u = users[uid]; if(!u) return; if(u.fcmToken) _raw.push(u.fcmToken); if(u.fcmTokens) Object.keys(u.fcmTokens).forEach(k => { if(u.fcmTokens[k]) _raw.push(u.fcmTokens[k]); }); });
  const tokens = [...new Set(_raw)];
  if(!tokens.length) return;
  const isHigh = !!high;
  try {
    await admin.messaging().sendEachForMulticast({
      notification: { title, body },
      data: { typ: 'pripominka' },
      android: { priority: isHigh ? 'high' : 'normal', notification: { priority: isHigh ? 'max' : 'default', defaultSound: true } },
      apns: { headers: { 'apns-priority': isHigh ? '10' : '5' }, payload: { aps: { sound: 'default', 'interruption-level': isHigh ? 'time-sensitive' : 'active' } } },
      webpush: { headers: { Urgency: isHigh ? 'high' : 'normal' }, notification: { requireInteraction: isHigh } },
      tokens: tokens
    });
  } catch(e) { console.error('reminder push chyba:', e); }
}

exports.checkReminders = functions
  .region('europe-west1')
  .pubsub.schedule('every 15 minutes')
  .timeZone('Europe/Prague')
  .onRun(async () => {
    const now = Date.now();
    const DAY = 24 * 3600 * 1000;
    const OFF = { '1h': 3600e3, '3h': 3 * 3600e3, '1d': DAY, '2d': 2 * DAY };
    const snap = await db.ref('/ukoly').once('value');
    const tasks = snap.val() || {};
    const updates = {};
    for(const id of Object.keys(tasks)) {
      const t = tasks[id];
      if(!t || t.stav === 'done' || !t.pripominka) continue;
      const p = t.pripominka;
      const recips = [t.zadalUid].concat((t.prirazeno || []).map(x => x && x.uid)).filter(Boolean);
      const high = t.priorita === 'vysoka';
      if(p.typ === 'cas') {
        if(typeof p.at !== 'number') continue;
        if(now >= p.at && (p.sentAt || 0) < p.at) {
          await _sendPush(recips, '⏰ Připomínka úkolu', t.title || '', high);
          if(p.rep === 'day')       { updates['ukoly/' + id + '/pripominka/at'] = p.at + DAY;     updates['ukoly/' + id + '/pripominka/sentAt'] = now; }
          else if(p.rep === 'week') { updates['ukoly/' + id + '/pripominka/at'] = p.at + 7 * DAY; updates['ukoly/' + id + '/pripominka/sentAt'] = now; }
          else                      { updates['ukoly/' + id + '/pripominka/sentAt'] = now; }
        }
      } else if(p.typ === 'termin') {
        if(!t.termin) continue;
        const terminTs = Date.parse(t.termin + 'T07:00:00');   // ráno v den termínu
        if(isNaN(terminTs)) continue;
        const remindAt = terminTs - (OFF[p.before] || DAY);
        if(now >= remindAt && (p.sentAt || 0) < remindAt) {
          await _sendPush(recips, '⏰ Blíží se termín úkolu', (t.title || '') + ' (termín ' + t.termin + ')', high);
          updates['ukoly/' + id + '/pripominka/sentAt'] = now;
        }
      }
    }
    if(Object.keys(updates).length) await db.ref().update(updates);
    return null;
  });

/* ════════════════════════════════════════════════════════════════
   denikVytah – AI stručný denní zápis do (provizorního) stavebního deníku.
   Klient pošle sestavený textový přehled dne (lidé/firmy/SO, stroje, záznamy,
   materiály, počasí, závěr), funkce nechá Claude Haiku udělat věcný zápis.
   Vrací {ok, vytah}. Secret ANTHROPIC_API_KEY (stejný jako tagFoto).
   ════════════════════════════════════════════════════════════════ */
const DENIK_PROMPT =
  'Jsi zkušený stavbyvedoucí a píšeš zápis do stavebního deníku. Z níže uvedených podkladů z jednoho dne ' +
  'udělej STRUČNÝ, věcný český zápis (bez omáčky, bez úvodních frází). Rozděl podle stavebních objektů (SO), ' +
  'kde to jde. Uveď: kdo a kolik lidí / firem pracovalo a na čem, nasazené stroje, provedené činnosti, ' +
  'materiály, počasí a závěr dne. Použij krátké odrážky. Max ~14 řádků. Nevymýšlej nic, co v podkladech není.';

exports.denikVytah = functions
  .region('europe-west1')
  .runWith({ secrets: ['ANTHROPIC_API_KEY'] })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if(req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if(req.method !== 'POST')    { res.status(405).json({ error: 'Jen POST' }); return; }
    try {
      const b = req.body || {};
      const text = String(b.text || '').trim().slice(0, 8000);
      const date = String(b.date || '');
      if(!text) { res.status(400).json({ error: 'Chybí podklady' }); return; }
      const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 700,
          messages: [{ role: 'user', content: DENIK_PROMPT + '\n\nDatum: ' + date + '\n\nPODKLADY:\n' + text }]
        })
      });
      if(!aiResp.ok) { const et = await aiResp.text(); console.error('Claude chyba', aiResp.status, et); res.status(502).json({ error: 'AI zápis selhal (' + aiResp.status + ')' }); return; }
      const ai = await aiResp.json();
      let vytah = '';
      if(ai && Array.isArray(ai.content)) { const t = ai.content.find(c => c.type === 'text'); if(t) vytah = String(t.text || '').trim(); }
      if(!vytah) { res.status(502).json({ error: 'AI vrátila prázdný zápis' }); return; }
      res.status(200).json({ ok: true, vytah: vytah });
    } catch(err) { console.error('denikVytah výjimka:', err); res.status(500).json({ error: 'Zápis selhal' }); }
  });

// ── DENNÍ ZÁLOHA celé Realtime Database do privátního Storage ──────────
// Jednou denně uloží celou RTDB jako JSON do bucketu (zalohy/db-YYYY-MM-DD.json + db-latest.json).
// Kryje TEXTOVÁ data: úkoly, poznámky, deník, KZP, podpisy, práva/kategorie, metadata+vazby fotek.
// Samotné SOUBORY fotek/PDF nekryje – ty chrání Object Versioning na bucketu (zapni v konzoli).
// Obnova: Console → Storage → zalohy/ → stáhnout JSON → Realtime Database → ⋮ → Import JSON (přepíše!).
exports.backupDatabase = functions
  .region('europe-west1')
  .pubsub.schedule('every 24 hours')
  .timeZone('Europe/Prague')
  .onRun(async () => {
    try {
      const data = (await db.ref('/').once('value')).val() || {};
      const json = JSON.stringify(data);
      const stamp = new Date().toISOString().slice(0, 10);
      const bucket = admin.storage().bucket(SUB_BUCKET);
      const opts = { contentType: 'application/json', resumable: false };
      await bucket.file('zalohy/db-' + stamp + '.json').save(json, opts);
      await bucket.file('zalohy/db-latest.json').save(json, opts);
      console.log('Záloha DB OK: ' + stamp + ' (' + json.length + ' B)');
    } catch (err) {
      console.error('Záloha DB selhala:', err);
    }
    return null;
  });

/* ════════════════════════════════════════════════════════════════
   HTTPS FUNKCE – extractDodaciList: AI vytěžení DODACÍHO LISTU z fotky
   - Klient pošle POST { image (base64, i s data: prefixem), mime } + Firebase ID token
   - Vrátí { ok, fields:{co,mnozstvi,jednotka,dodavatel,cisloDL,datum,spz} }.
   - Klíč ANTHROPIC_API_KEY je SECRET. Model Haiku 4.5 (~haléře/fotka).
   DEPLOY: firebase functions:secrets:set ANTHROPIC_API_KEY
           firebase deploy --only functions:extractDodaciList
   ════════════════════════════════════════════════════════════════ */
exports.extractDodaciList = functions
  .region('europe-west1')
  .runWith({ secrets: ['ANTHROPIC_API_KEY'], timeoutSeconds: 60, memory: '512MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if(req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if(req.method !== 'POST')    { res.status(405).json({ error: 'Jen POST' }); return; }

    const authHeader = req.get('Authorization') || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if(!idToken) { res.status(401).json({ error: 'Chybí přihlášení' }); return; }
    try { await admin.auth().verifyIdToken(idToken); }
    catch(e) { res.status(401).json({ error: 'Neplatné přihlášení' }); return; }

    const body = req.body || {};
    let image = String(body.image || '').replace(/^data:[^;]+;base64,/, '');
    const mime = /png/i.test(String(body.mime || '')) ? 'image/png' : 'image/jpeg';
    if(!image || image.length > 8 * 1024 * 1024) {
      res.status(400).json({ error: 'Chybí nebo příliš velký obrázek' }); return;
    }

    const extra = Array.isArray(body.extra) ? body.extra.slice(0,8) : [];
    const extraKeys = extra.map(function(e){ return String((e&&e.key)||'').replace(/[^a-zA-Z0-9_]/g,'').slice(0,32); }).filter(Boolean);
    const extraJson = extraKeys.map(function(k){ return '"'+k+'":""'; }).join(',');
    const extraDesc = extra.map(function(e){ var k=String((e&&e.key)||'').replace(/[^a-zA-Z0-9_]/g,'').slice(0,32); return k?(k+'='+String((e&&e.hint)||'').slice(0,140)):''; }).filter(Boolean).join('; ');
    const PROMPT = 'Na obrázku je DODACÍ LIST (dodávka materiálu na stavbu silnice v ČR). '
      + 'Vytáhni údaje a vrať POUZE JSON (žádný jiný text) přesně v tomto tvaru:\n'
      + '{"dodavatel":"","cisloDL":"","datum":"","spz":"","polozky":[{"co":"","specifikace":"","mnozstvi":"","jednotka":""}]' + (extraJson ? (','+extraJson) : '') + '}\n'
      + 'Význam: dodavatel=kdo dodal (firma/závod/obalovna); cisloDL=číslo dodacího listu; datum=datum na dokladu ve formátu RRRR-MM-DD; spz=SPZ vozidla pokud je uvedena. '
      + 'polozky=seznam VŠECH dodaných položek na dokladu (u betonu obvykle jedna, u stavebnin i více řádků). Každá položka: co=materiál/zboží stručně (Beton, Obalované kamenivo, Ocel…); specifikace=třída/pevnost/značka – u betonu VŽDY plné značení (C30/37 XF4 XC4 Cl0,4 Dmax22 S4), u oceli B500B apod.; mnozstvi=jen číselná hodnota; jednotka=t/m3/ks/m/kg. '
      + (extraDesc ? ('Dále z dokladu vytáhni tyto údaje: ' + extraDesc + '. ') : '')
      + 'Když údaj nenajdeš, dej prázdný řetězec (v polozky vrať aspoň jednu položku). Nic jiného nepiš.';

    try {
      const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1024,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: image } },
            { type: 'text', text: PROMPT }
          ]}]
        })
      });
      const data = await aiResp.json();
      if(!aiResp.ok) {
        console.error('Anthropic err:', aiResp.status, JSON.stringify(data));
        res.status(502).json({ error: (data && data.error && data.error.message) || 'AI chyba' }); return;
      }
      let text = '';
      try { text = (data.content || []).map(function(b){ return b && b.type === 'text' ? b.text : ''; }).join(''); } catch(e){}
      let parsed = {};
      try { const m = text.match(/\{[\s\S]*\}/); if(m) parsed = JSON.parse(m[0]) || {}; } catch(e){ console.warn('parse JSON z AI selhal:', e && e.message); }
      const polozky = Array.isArray(parsed.polozky) ? parsed.polozky.map(function(it){ it=it||{}; return { co:String(it.co||''), specifikace:String(it.specifikace||''), mnozstvi:String(it.mnozstvi||''), jednotka:String(it.jednotka||'') }; }).filter(function(it){ return it.co||it.specifikace||it.mnozstvi||it.jednotka; }) : [];
      const first = polozky[0] || {};
      const fields = { co:String(first.co||''), specifikace:String(first.specifikace||''), mnozstvi:String(first.mnozstvi||''), jednotka:String(first.jednotka||''), dodavatel:String(parsed.dodavatel||''), cisloDL:String(parsed.cisloDL||''), datum:String(parsed.datum||''), spz:String(parsed.spz||'') };
      const extraVals = {}; extraKeys.forEach(function(k){ if(parsed[k] != null) extraVals[k] = String(parsed[k]); });
      res.status(200).json({ ok: true, fields: fields, polozky: polozky, extra: extraVals, usage: data.usage || null });
    } catch(e) {
      console.error('extractDodaciList výjimka:', e);
      res.status(500).json({ error: 'Chyba serveru při AI' });
    }
  });
