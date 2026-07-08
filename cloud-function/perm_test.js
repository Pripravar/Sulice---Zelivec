const fs=require('fs');
const src=fs.readFileSync('index.html','utf8');
function grab(name){                       // vytáhne celou funkci podle jména (párování závorek)
  const i=src.indexOf('function '+name+'(');
  if(i<0) throw new Error('nenalezeno: '+name);
  let d=0,j=src.indexOf('{',i);
  for(let k=j;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d) return src.slice(i,k+1);} }
}
function grabVar(name){
  const re=new RegExp('var '+name+'\\s*=\\s*[\\[{]');
  const i=src.search(re); let j=src.indexOf(src[src.search(re)+src.slice(src.search(re)).search(/[\[{]/)],i);
  let d=0; for(let k=j;k<src.length;k++){ const c=src[k];
    if(c==='['||c==='{')d++; else if(c===']'||c==='}'){d--; if(!d) return src.slice(i,k+1)+';'; } }
}
let toasts=[];
const sandbox={ window:{}, showToast:(m)=>toasts.push(m), console,
  document:{ getElementById:()=>({checked:true}) } };
sandbox.window.window=sandbox.window;
const code=[
  grabVar('ADMIN_UIDS')||"var ADMIN_UIDS=['ADMINUID'];",
  grabVar('CATEGORIES'), grabVar('DEFAULT_CATEGORY_PERMS'), grabVar('FEATURES'), grabVar('LAYER_PERM'),
  grab('isAdmin'), grab('isBlocked'), grab('userCategory'), grab('isSubOnly'), grab('isInvestorOnly'),
  grab('isRestrictedCategory'), grab('_catDefaults'), grab('categoryAllows'), grab('hasPerm'), grab('canViewPhoto')
].join('\n');
const vm=require('vm'); vm.createContext(sandbox); vm.runInContext(code,sandbox);
const W=sandbox.window;
let fail=0; const ok=(c,m)=>{ if(!c){console.log('  ❌ '+m); fail++;} else console.log('  ✅ '+m); };

function as(cat,uid='u'){ W.currentUser={uid,name:'X'}; W.allUsers={[uid]:{uid,kategorie:cat}}; W._usersLoaded=true; W.categoryPerms=null; W.subMode=null; }

console.log('\n── INVESTOR: nesmí zapnout cizí vrstvy ani vidět cizí fotky ──');
as('investor');
['fotomapa','katastr','trasa','objekty','situace','pripominky','ukoly','mereni','zkousky','dron','denik','pdf','vykresy'].forEach(k=>
  ok(sandbox.hasPerm(k)===false, 'hasPerm("'+k+'") === false'));
ok(sandbox.hasPerm('foto')===true,'foto povoleno (focení)');
ok(sandbox.hasPerm('galerie')===true,'galerie povolena');
ok(sandbox.hasPerm('gps')===true,'gps povoleno (nutné k focení!)');
ok(sandbox.canViewPhoto({url:'a'})===false,'cizí fotka týmu NEviditelná');
ok(sandbox.canViewPhoto({zdroj:'SUB'})===false,'fotka subky NEviditelná');
ok(sandbox.canViewPhoto({sdilenoInvestor:true})===true,'fotka sdílená jemu viditelná');
ok(sandbox.canViewPhoto(null)===false,'fotka bez metadat NEviditelná (fail-closed)');

console.log('\n── SUBKA ──');
as('sub');
ok(sandbox.hasPerm('foto')&&sandbox.hasPerm('galerie')&&sandbox.hasPerm('gps'),'focení+galerie+gps dál funguje');
ok(sandbox.hasPerm('orientace')===true,'orientační vrstvy povolené');
ok(sandbox.hasPerm('fotomapa')===false,'fotomapa zakázaná');
ok(sandbox.canViewPhoto({zdroj:'SUB'})===true,'vidí SUB fotku');
ok(sandbox.canViewPhoto({sdilenoSub:true})===true,'vidí sobě sdílenou');
ok(sandbox.canViewPhoto({sdilenoInvestor:true})===false,'NEvidí investorskou');
ok(sandbox.canViewPhoto({url:'a'})===false,'NEvidí cizí týmovou');

console.log('\n── REGRESE: náš tým (silnice) + admin musí mít VŠE ──');
as('silnice');
ok(sandbox.FEATURES.every(f=>sandbox.hasPerm(f.key)),'silnice: hasPerm(všech '+sandbox.FEATURES.length+' klíčů) === true');
ok(sandbox.canViewPhoto({url:'a'})===true,'silnice vidí všechny fotky');
W.currentUser={uid:sandbox.ADMIN_UIDS[0]}; W.allUsers={[sandbox.ADMIN_UIDS[0]]:{kategorie:'investor'}};
ok(sandbox.FEATURES.every(f=>sandbox.hasPerm(f.key)),'admin má vše i s kategorií investor');
ok(sandbox.canViewPhoto({url:'a'})===true,'admin vidí vše');

console.log('\n── FAIL-OPEN past: smazaný záznam ──');
W.currentUser={uid:'ghost'}; W.allUsers={someone:{}}; W._usersLoaded=true;
ok(sandbox.hasPerm('pdf')===false && sandbox.hasPerm('foto')===false,'smazaný uživatel nemá NIC (fail-closed)');

console.log('\n── LAYER_PERM pokrývá všechny volané vrstvy ──');
const called=[...src.matchAll(/toggleLayer\('([a-zA-Z0-9]+)'/g)].map(m=>m[1]);
const missing=[...new Set(called)].filter(n=>!sandbox.LAYER_PERM[n]);
ok(missing.length===0, missing.length?('chybí v LAYER_PERM: '+missing.join(', ')):'všech '+new Set(called).size+' vrstev v toggleLayer má právo');


console.log('\n── MIGRACE: stará uložená mapa práv bez nových klíčů ──');
as('sub');
W.categoryPerms={ sub:{ foto:true, galerie:true } };   // uloženo PŘED přidáním gps/orientace
ok(sandbox.hasPerm('gps')===true,'gps zdědí seed → subce dál funguje focení');
ok(sandbox.hasPerm('orientace')===true,'orientace zdědí seed');
ok(sandbox.hasPerm('fotomapa')===false,'fotomapa zůstává zakázaná');
W.categoryPerms={ sub:{ foto:true, galerie:true, gps:false } };  // admin gps VÝSLOVNĚ zakázal
ok(sandbox.hasPerm('gps')===false,'výslovné admin false má přednost před seedem');

console.log('\n'+(fail? '❌ SELHALO '+fail+' testů':'✅ VŠECHNY TESTY PROŠLY'));
process.exit(fail?1:0);
