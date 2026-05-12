# Úkolníček + push notifikace — setup návod

Aktuální verze (`index.html` ze dne 2026-05-12) přidává:

- ✅ Úkolníček (seznam úkolů, přiřazení osob, termíny, komentáře)
- 🔐 Přihlášení Googlem (Firebase Auth)
- 📲 Push notifikace (Web Push / Firebase Cloud Messaging)
- 📱 PWA — appku lze přidat na plochu telefonu

**Pokud nevyplníš kroky níže, aplikace pojede v "legacy" módu** (jen mapa + poznámky, jak doteď). Tlačítko úkolů se schová a do varování v console se vypíše, co chybí.

---

## 1. Firebase Console — zapnout Authentication

1. Otevři https://console.firebase.google.com → projekt **sulice-zelivec**
2. Levé menu → **Authentication** → tab **Sign-in method** → **Add new provider** → **Google** → **Enable** → ulož.
3. Tab **Settings** → **Authorized domains** → přidej:
   - `pripravar.github.io` (kde appka běží)
   - `localhost` (pro testování)

## 2. Firebase Console — získat web SDK konfiguraci

1. ⚙️ ozubené kolo vedle **Project Overview** → **Project settings**.
2. Sjeď dolů na **Your apps**. Pokud tam webová aplikace ještě není:
   - Klepni 🌐 (Web) → název "Sulice-Zelivec web" → **Register app**.
3. Z bloku **SDK setup and configuration** (možnost "Config") opiš hodnoty:
   - `apiKey`
   - `authDomain` (zachovat stávající: `sulice-zelivec.firebaseapp.com`)
   - `messagingSenderId`
   - `appId`

Tyto hodnoty doplň do `index.html` (najdi blok `FIREBASE_CONFIG`) a do `firebase-messaging-sw.js` (stejné hodnoty na obou místech).

## 3. Firebase Console — Web Push VAPID klíč

1. **Project settings** → tab **Cloud Messaging**.
2. Sekce **Web configuration** → **Web Push certificates** → **Generate key pair**.
3. Vyšlou se ~88 znaků dlouhý klíč. Zkopíruj a vlož do `index.html` jako hodnotu `FIREBASE_VAPID_KEY`.

## 4. Realtime Database — pravidla

Současná pravidla `.read/.write = true` nadále stačí pro provoz. Pokud chceš později omezit přístup jen na přihlášené, použij:

```json
{
  "rules": {
    ".read":  "auth != null",
    ".write": "auth != null"
  }
}
```

**Pozn.** Tohle nelze zapnout dokud všichni uživatelé nezačnou používat přihlášení — jinak rozbiješ stávající poznámky.

## 5. Cloud Function — deploy

Pro odesílání push notifikací je potřeba mít Firebase plán **Blaze** (pay-as-you-go). Free tier pokryje stovky notifikací denně bez nákladů, ale Firebase chce mít na účtu kartu pro případ překročení limitu.

1. Instaluj Node.js 18+ a Firebase CLI:
   ```bash
   npm install -g firebase-tools
   ```
2. V terminálu otevři složku **cloud-function/**:
   ```bash
   cd cloud-function
   npm install
   firebase login
   firebase use sulice-zelivec
   firebase deploy --only functions
   ```
3. Po úspěšném deployi se v Firebase Console → **Functions** zobrazí `sendTaskNotifications`.

> **Tip:** Pokud Cloud Function nikdy nenasadíš, úkolníček bude fungovat — jen nebudou chodit notifikace. Push příjem v telefonu pak nemá co spouštět.

## 6. iPhone — přidat appku na plochu

Bez tohohle iPhone notifikace nedostane (omezení Applu):

1. Otevři appku v Safari na iPhone.
2. Klepni na **Sdílet** (čtvereček se šipkou).
3. **Přidat na plochu** → **Přidat**.
4. Otevři appku z plochy (nikoli ze Safari) → klepni **Povolit** na notifikační prompt.

Android Chrome notifikace bere bez tohoto kroku.

---

## Datový model ve Firebase Realtime DB

```
/uzivatele/{uid}        = {uid, name, email, photo, fcmToken, lastSeen}
/poznamky/{id}          = (stávající – beze změny)
/ukoly/{id}             = {id, title, text, zadalUid, zadalName,
                            prirazeno:[{uid,name},…],
                            termin:'YYYY-MM-DD', priorita, profese,
                            stav:'open'|'done',
                            lat?, lng?, km?,
                            vytvoreno, upraveno, hotovo?, hotovilUid?, hotovilName?,
                            komentare:{
                              {cid}:{id,uid,name,text,time}
                            }}
/notifikace_fronta/{id} = (dočasná fronta; Cloud Function ji čte a maže)
```

---

## Zálohy

Před změnou je vždy uložena záloha v podsložce `index YYYY-MM-DD/index.html`.
Pokud něco přestane fungovat, stačí starou verzi překopírovat zpět:

```bash
cp "index 2026-05-12/index.html" index.html
```

Po commitnutí a pushnutí na GitHub se aplikace obnoví během 1–2 minut.
