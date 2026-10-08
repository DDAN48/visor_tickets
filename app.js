(() => {
  const C = window.OFSC_FRONT_CONFIG;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const PAGE_SIZE = 100;
  const DEFAULT_EXCLUSIONS = {
    contractors:['DDL','PERSONAL_PROPIO'],
    eventSiglas:['MT','ME','FP','LK','EN','MF','RR','MZ','YI','YP'],
    taskSiglas:['RIL','MPR','CFO','ATT','VTT','NRI','MPT'],
    statuses:[]
  };
  const LIVE_KEYS = new Set(['suspended','assigned','enroute','started','scheduled']);
  const STORAGE_KEY='ofsc_exclusions_v22_4';
  // Orden de columnas: primero las visibles por defecto; el resto queda disponible en "Columnas".
  const COLUMN_DEFS = [
    ['task','Tarea'],['created','Creado'],['affected','Afectación'],['priority','Prioridad'],['node','Nodo'],['tipif','Tipif'],['status','Estado'],
    ['subcapa','Subcapa'],['origin','Origen'],['event','Ticket Evento'],['parentEvent','Evento Padre'],['ageDays','Antigüedad'],['contractor','Contratista'],['scheduled','Agendado'],
    ['tipificacion','Tipificación tarea'],['capa','Capa'],['eventSigla','Sigla Evento'],['startTime','Start Time'],['endTime','End Time'],['tech','Técnico / móvil'],['resource','ID Recurso'],['tree','Árbol']
  ];
  const INITIAL_VISIBLE_COLUMNS = new Set(['task','created','affected','priority','node','tipif','status','subcapa','origin','event','parentEvent','ageDays','contractor','scheduled']);
  const ESSENTIAL_COLUMNS = INITIAL_VISIBLE_COLUMNS;
  const TOP_TO_COLUMN = {Estado:'status',Contratista:'contractor',Arbol:'tree',Capa:'capa',SubCapa:'subcapa',Tipif:'tipif',Afectacion:'affected'};
  const COLUMN_TO_TOP = Object.fromEntries(Object.entries(TOP_TO_COLUMN).map(([k,v])=>[v,k]));

  const state = {
    tab:C.DEFAULT_TAB||'operativo', subtab:'tasks', raw:[], analyticsRaw:[], current:[], filtered:[], page:1,
    meta:{apiTotal:0,uniqueTotal:0}, filterValues:{}, topFilters:{}, colFilters:{}, textFilters:{},
    defaultLiveStatuses:new Set(), map:null, markers:null, histData:[], loading:false, hiddenColumns:new Set(COLUMN_DEFS.map(x=>x[0]).filter(k=>!INITIAL_VISIBLE_COLUMNS.has(k))),
    exclusions:cloneDefaults(), sort:{key:'created',direction:1}, columnSelections:{}, columnValueCache:{}, kpiValues:[],
    loadedRange:{from:'',to:''}, analyticsRange:{from:'',to:''}, taskHistoryCache:new Map(), backgroundLoading:false
  };

  const norm=v=>String(v??'').trim();
  const upper=v=>norm(v).toUpperCase();
  const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const fmt=v=>(v===null||v===undefined||v==='')?'—':String(v);
  const parseDate=v=>{ if(!v)return null; const raw=String(v).trim(); const d=new Date(raw.includes('T')?raw:raw.replace(' ','T')); return Number.isNaN(d.getTime())?null:d; };
  const formatDate=v=>{const d=parseDate(v);return d?d.toLocaleString('es-AR',{dateStyle:'short',timeStyle:'short'}):fmt(v)};
  const formatDateOnly=v=>{const d=parseDate(v);return d?d.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric'}):fmt(v)};
  const formatLongDateTime=v=>{const d=parseDate(v);return d?d.toLocaleString('es-AR',{weekday:'long',day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):fmt(v)};
  const showToast=(m,ms=4200)=>{const t=$('#toast');t.textContent=m;t.classList.remove('hidden');clearTimeout(showToast._t);showToast._t=setTimeout(()=>t.classList.add('hidden'),ms)};
  function cloneDefaults(){return {contractors:[...DEFAULT_EXCLUSIONS.contractors],eventSiglas:[...DEFAULT_EXCLUSIONS.eventSiglas],taskSiglas:[...DEFAULT_EXCLUSIONS.taskSiglas],statuses:[...DEFAULT_EXCLUSIONS.statuses]};}
  function normalizeList(v){return [...new Set((Array.isArray(v)?v:String(v||'').split(/[,;\n]+/)).map(x=>upper(x)).filter(Boolean))];}

  function statusKey(s){const t=norm(s).toLowerCase();if(/complete|complet/.test(t))return'completed';if(/cancel/.test(t))return'cancelled';if(/notdone|not.?done|no.?realiz/.test(t))return'notdone';if(/suspend/.test(t))return'suspended';if(/start|inici/.test(t))return'started';if(/en.?route|enrut|en.?viaje|travel/.test(t))return'enroute';if(/schedule|agend/.test(t))return'scheduled';if(/pending|asign/.test(t))return'assigned';return'other';}
  function statusEs(s){const k=statusKey(s);return ({completed:'COMPLETADA',cancelled:'CANCELADA',notdone:'NO REALIZADA',suspended:'SUSPENDIDA',started:'INICIADA',assigned:'ASIGNADA',enroute:'ENRUTADA',scheduled:'AGENDADA'})[k]||upper(s)||'—';}
  const isLiveStatus=s=>LIVE_KEYS.has(statusKey(s));
  const statusClass=s=>statusKey(s);
  const badgeStatus=s=>`<span class="badge ${statusClass(s)}">${esc(statusEs(s))}</span>`;
  const ageClass=d=>Number(d)>=3?'age-red':Number(d)>=2?'age-yellow':'age-green';
  const capaClass=v=>{const x=norm(v).toLowerCase();if(x.includes('edificio'))return'edificio';if(x.includes('infra'))return'infra';if(x.includes('fibra'))return'fibra';if(x.includes('usac'))return'usac';if(x.includes('ingress'))return'ingress';if(x.includes('leak'))return'leak';return''};
  const taskId=r=>norm(r.Tarea||r.apptNumber||r.activityId);
  const siglaTarea=r=>norm(r.Tipif||r.SiglaTarea||(taskId(r).match(/^\d{6}([A-Z]{3})/)||[])[1]);
  const oracleEvent=r=>norm(r.TicketEvento||r.XA_Eventticket||r.ticket_evento);
  const parentEvent=r=>norm(r.EventoTableau||r.evento_tableau||r.EventoPadre||r.evento_padre)||oracleEvent(r);
  const eventCode=r=>oracleEvent(r)||parentEvent(r);
  const eventSigla=r=>norm(r.SiglaEvento||r.EventoSigla||(eventCode(r).match(/^\d{6}([A-Z]{2})/)||[])[1]);
  const createdValue=r=>r.CreadoExacto||r.Creado||r.creado_exacto||'';
  const startValue=r=>r.StartTime||r.startTime||r.start_time||'';
  const endValue=r=>r.EndTime||r.endTime||r.end_time||'';
  const interventionTimestamp=r=>{for(const v of [endValue(r),startValue(r),r.FechaEfectiva,r.fecha_intervencion,r.FechaIntervencion,r.Agendado,r.date]){const d=parseDate(v);if(d)return d.getTime();}return 0;};
  const serialCount=v=>{if(v===null||v===undefined||v==='')return 0;if(typeof v==='number')return v;const n=Number(v);if(Number.isFinite(n))return n;const d=parseDate(v);if(d&&d.getUTCFullYear()<=1901){const epoch=Date.UTC(1899,11,30);return Math.round((d.getTime()-epoch)/86400000);}return 0;};
  const suspendedCount=r=>serialCount(r.VecesSuspendida??r.veces_suspendida);
  const totalAssignments=r=>serialCount(r.TotalAsignaciones??r.total_asignaciones);
  const affected=r=>norm(r.Afectacion||r.afectacion);
  const priority=r=>norm(r.XA_Priority||r.Priority||r.Prioridad||r.priority);
  const origin=r=>norm(r.Origen||r.origen);
  const tree=r=>norm(r.Arbol||r.arbol);
  const contractor=r=>{
    const raw=norm(r.Contratista||r.contratista);
    const key=upper(raw).replace(/[ _-]+/g,' ').replace(/\s+/g,' ').trim();
    if(key==='RD CONSTRUCCIONES'||key==='CONSTRUCCIONES RD')return 'RD_CONSTRUCCIONES';
    return raw;
  };
  const tech=r=>norm(r.Tecnico||r.resourceName||r.tecnico);
  const resource=r=>norm(r.IDRecurso||r.resourceId||r.id_recurso);
  const capa=r=>norm(r.Capa||r.capa);
  const subcapa=r=>norm(r.SubCapa||r.subcapa);
  const node=r=>norm(r.Nodo||r.nodo);
  const scheduled=r=>r.Agendado||r.agendado||r.date||'';
  const ageDays=r=>{const direct=Number(r.AntiguedadDias);if(Number.isFinite(direct))return direct;const d=parseDate(createdValue(r));return d?Math.max(0,(Date.now()-d.getTime())/86400000):null;};

  /*
     ESTADO ACTUAL POR TAREA
     No confiamos en el orden físico de DATA. Una tarea puede tener varias
     intervenciones el mismo día (por ejemplo SUSPENDIDA y luego COMPLETADA).
     El registro actual es el de la intervención más reciente, usando:
       End Time -> Start Time -> FechaEfectiva -> Agendado -> date.
     Si dos registros empatan exactamente, se prioriza un estado terminal
     (COMPLETADA/CANCELADA/NO REALIZADA) y luego el activityId mayor.
  */
  function currentSnapshot(rows){
    const map=new Map();
    for(const r of rows){
      const id=taskId(r);
      if(!id)continue;
      const prev=map.get(id);
      if(!prev){map.set(id,r);continue;}

      const ts=interventionTimestamp(r);
      const prevTs=interventionTimestamp(prev);
      if(ts>prevTs){map.set(id,r);continue;}
      if(ts<prevTs)continue;

      const k=statusKey(r.Estado||r.status);
      const pk=statusKey(prev.Estado||prev.status);
      const terminal=new Set(['completed','cancelled','notdone']);
      if(terminal.has(k)&&!terminal.has(pk)){map.set(id,r);continue;}
      if(terminal.has(k)===terminal.has(pk)){
        const a=Number(r.activityId||r.ActivityID||0);
        const b=Number(prev.activityId||prev.ActivityID||0);
        if(Number.isFinite(a)&&Number.isFinite(b)&&a>b)map.set(id,r);
      }
    }
    return [...map.values()];
  }
  function historyForTask(id){return state.raw.filter(r=>taskId(r)===id).sort((a,b)=>interventionTimestamp(b)-interventionTimestamp(a));}
  function taskEventDate(r){const m=eventCode(r).match(/^(\d{2})(\d{2})(\d{2})/);if(!m)return null;const d=new Date(2000+Number(m[1]),Number(m[2])-1,Number(m[3]));return Number.isNaN(d.getTime())?null:d;}

  function loadSavedExclusions(){state.exclusions=cloneDefaults();}
  function saveExclusions(){}
  function passesExclusions(r){return !state.exclusions.contractors.includes(upper(contractor(r)))&&!state.exclusions.taskSiglas.includes(upper(siglaTarea(r)))&&!state.exclusions.eventSiglas.includes(upper(eventSigla(r)))&&!state.exclusions.statuses.includes(upper(statusEs(r.Estado||r.status)));}

  function setLoading(on,title='Cargando información…',detail='',pct=0){state.loading=on;$('#loadingOverlay').classList.toggle('hidden',!on);$('#loadingTitle').textContent=title;$('#loadingDetail').textContent=detail;$('#loadingBar').style.width=`${Math.max(0,Math.min(100,pct))}%`;}
  function setTab(tab){state.tab=tab;$$('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));$$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${tab}`));$('#subtitle').textContent=tab==='operativo'?'Operativo OFSC · tickets abiertos':'Histórico D1';if(tab==='historico'&&!state.histData.length)loadHistoricoResumen();}
  function setSubtab(tab){state.subtab=tab;$$('.subtab').forEach(b=>b.classList.toggle('active',b.dataset.subtab===tab));$$('.subview').forEach(v=>v.classList.toggle('active',v.id===`subview-${tab}`));if(tab==='mobiles')renderMobiles();if(tab==='contractors')renderContractors();}
  async function fetchJson(url,opts={},timeoutMs=30000){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const r=await fetch(url,{...opts,signal:controller.signal});
      const txt=await r.text();
      let j;
      try{j=JSON.parse(txt)}catch{throw new Error(`Respuesta no JSON (${r.status})`)}
      if(!r.ok||j.ok===false)throw new Error(j.error||`HTTP ${r.status}`);
      return j;
    }catch(e){
      if(e?.name==='AbortError')throw new Error(`Tiempo de espera agotado (${Math.round(timeoutMs/1000)} s)`);
      throw e;
    }finally{clearTimeout(timer);}
  }

  function localYmd(date=new Date()){
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }

  function shiftLocalDays(base,delta){
    const d=new Date(base.getFullYear(),base.getMonth(),base.getDate()+delta,12,0,0,0);
    return d;
  }

  /*
    Operativo fijo: no depende de filtros de fecha del usuario.
    -2 días captura estados recientes (incluye ayer/anteayer).
    +30 días captura tareas futuras agendadas/asignadas en OFSC.
    El histórico individual se consulta aparte, a demanda.
  */
  function operationalRange(){
    const now=new Date();
    return {
      from:localYmd(shiftLocalDays(now,-2)),
      to:localYmd(shiftLocalDays(now,30))
    };
  }

  function segmentedOperationalRanges(){
    const now=new Date();
    return [
      {key:'actual',label:'Operación actual',from:localYmd(shiftLocalDays(now,-2)),to:localYmd(shiftLocalDays(now,2))},
      {key:'near',label:'Futuro cercano',from:localYmd(shiftLocalDays(now,3)),to:localYmd(shiftLocalDays(now,10))},
      {key:'future',label:'Programación futura',from:localYmd(shiftLocalDays(now,11)),to:localYmd(shiftLocalDays(now,30))}
    ];
  }

  function ensureOperationalDates(){
    const r=operationalRange();
    const label=$('#opWindowLabel');
    if(label)label.textContent=`${r.from} → ${r.to}  (fijo: -2 / +30 días)`;
    return r;
  }

  function currentRange(){
    return operationalRange();
  }

  function apiUrlAll(forceRefresh=false){
    const u=new URL(C.OPERATIVO_URL);
    u.searchParams.set('all','1');
    u.searchParams.set('compact','1');
    const {from:f,to:t}=currentRange();
    if(f)u.searchParams.set('from',f);
    if(t)u.searchParams.set('to',t);
    if(forceRefresh)u.searchParams.set('refresh','1');
    return u.toString();
  }

  function apiUrl(page=1,forceRefresh=false){
    const u=new URL(C.OPERATIVO_URL);
    u.searchParams.set('page',page);
    u.searchParams.set('limit',C.OPERATIVO_FALLBACK_PAGE_SIZE||1000);
    u.searchParams.set('compact','1');
    const {from:f,to:t}=currentRange();
    if(f)u.searchParams.set('from',f);
    if(t)u.searchParams.set('to',t);
    if(forceRefresh)u.searchParams.set('refresh','1');
    return u.toString();
  }

  function apiUrlAllRange(from,to,forceRefresh=false){
    const u=new URL(C.OPERATIVO_URL);
    u.searchParams.set('all','1');
    u.searchParams.set('compact','1');
    if(from)u.searchParams.set('from',from);
    if(to)u.searchParams.set('to',to);
    if(forceRefresh)u.searchParams.set('refresh','1');
    return u.toString();
  }

  function apiUrlPageRange(page,from,to,forceRefresh=false){
    const u=new URL(C.OPERATIVO_URL);
    u.searchParams.set('page',page);
    u.searchParams.set('limit',C.OPERATIVO_FALLBACK_PAGE_SIZE||1000);
    u.searchParams.set('compact','1');
    if(from)u.searchParams.set('from',from);
    if(to)u.searchParams.set('to',to);
    if(forceRefresh)u.searchParams.set('refresh','1');
    return u.toString();
  }

  function yesterdayTodayRange(){
    const now=new Date();
    const y=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1);
    return {from:localYmd(y),to:localYmd(now)};
  }

  async function loadAnalyticsYesterdayToday(forceRefresh=false){
    const range=yesterdayTodayRange();
    /*
      La ventana operativa fija (-2/+30) ya contiene ayer y hoy.
      Reutilizamos el mismo dataset para evitar una segunda llamada a Apps Script.
    */
    if(state.loadedRange.from<=range.from && state.loadedRange.to>=range.to && state.raw.length){
      state.analyticsRaw=state.raw;
      state.analyticsRange={...state.loadedRange};
      renderDailyStatePanel();
      return true;
    }
    console.warn('La ventana operativa no cubre ayer/hoy; no debería ocurrir.');
    state.analyticsRaw=[];
    renderDailyStatePanel();
    return false;
  }

  function opCacheKey(range){
    return `ofsc_operativo_cache_v2220_${range.from}_${range.to}`;
  }
  function saveOperationalCache(range,items,total){
    try{
      localStorage.setItem(opCacheKey(range),JSON.stringify({savedAt:Date.now(),items,total}));
    }catch(e){console.warn('No se pudo guardar cache operativo',e);}
  }
  function loadOperationalCache(range){
    try{
      const raw=localStorage.getItem(opCacheKey(range));
      if(!raw)return null;
      const obj=JSON.parse(raw);
      const maxAge=Number(C.OPERATIVO_CLIENT_CACHE_MAX_AGE_MS||21600000);
      if(!obj||!Array.isArray(obj.items)||!obj.savedAt||Date.now()-obj.savedAt>maxAge)return null;
      return obj;
    }catch{return null;}
  }

  async function fetchOperativoRangePage(page,from,to,totalPages=0,forceRefresh=false,label='Rango'){
    const maxAttempts=3;
    let lastError=null;
    for(let attempt=1;attempt<=maxAttempts;attempt++){
      try{
        if(attempt>1){
          setLoading(true,'Cargando operativo…',`${label}: página ${page}${totalPages?` de ${totalPages}`:''} · reintento ${attempt-1}/${maxAttempts-1}`);
          await new Promise(r=>setTimeout(r,800*attempt));
        }
        return await fetchJson(apiUrlPageRange(page,from,to,forceRefresh),{cache:'no-store'},Number(C.OPERATIVO_PAGE_TIMEOUT_MS||60000));
      }catch(e){lastError=e;}
    }
    throw new Error(`${label}, página ${page}: ${lastError?.message||lastError}`);
  }

  async function loadPaginatedRange(from,to,forceRefresh=false,label='Rango',first=null){
    const firstPage=first||await fetchOperativoRangePage(1,from,to,0,forceRefresh,label);
    const totalPages=Math.max(1,Number(firstPage.totalPages||1));
    const pages=new Array(totalPages);
    pages[0]=firstPage.items||[];
    for(let p=2;p<=totalPages;p++){
      setLoading(true,'Modo estable…',`${label}: página ${p} de ${totalPages}`,Math.round((p-1)/totalPages*100));
      const j=await fetchOperativoRangePage(p,from,to,totalPages,forceRefresh,label);
      pages[p-1]=j.items||[];
    }
    const items=pages.flat();
    return {items,total:Number(firstPage.total||items.length),mode:'paged'};
  }

  async function loadOneOperationalRange(segment,forceRefresh=false){
    let allError=null;
    for(let attempt=1;attempt<=2;attempt++){
      try{
        const one=await fetchJson(apiUrlAllRange(segment.from,segment.to,forceRefresh),{cache:'no-store'},Number(C.OPERATIVO_ALL_TIMEOUT_MS||50000));
        const items=Array.isArray(one.items)?one.items:[];
        const total=Number(one.total||items.length);
        const complete=(one.all===true)||(Number(one.totalPages||1)<=1)||(total>=0&&items.length===total);
        if(complete)return {items,total,mode:(one.cache==='HIT'?'cache-worker':'all')};
        allError=new Error('all=1 respondió paginado');
        if(Array.isArray(one.items)&&one.items.length){
          return await loadPaginatedRange(segment.from,segment.to,forceRefresh,segment.label,one);
        }
      }catch(e){allError=e;}
      if(attempt<2)await new Promise(r=>setTimeout(r,1000));
    }
    // Último recurso: paginación, pero SOLO dentro de este segmento temporal.
    try{return await loadPaginatedRange(segment.from,segment.to,forceRefresh,segment.label);}
    catch(e){throw new Error(`${segment.label}: ${e.message||allError?.message||e}`);}
  }

  function recordIdentity(r){
    const aid=norm(r.activityId||r.ActivityId||r.activity_id);
    if(aid)return `a:${aid}`;
    return `x:${taskId(r)}|${statusKey(r.Estado||r.status)}|${interventionTimestamp(r)}|${resource(r)}`;
  }

  function mergeOperationalRows(...groups){
    const map=new Map();
    for(const rows of groups){
      for(const r of (rows||[])){
        const k=recordIdentity(r);
        const prev=map.get(k);
        if(!prev||interventionTimestamp(r)>=interventionTimestamp(prev))map.set(k,r);
      }
    }
    return [...map.values()];
  }

  function sameSet(a,b){
    if(!(a instanceof Set)||!(b instanceof Set)||a.size!==b.size)return false;
    for(const v of a)if(!b.has(v))return false;
    return true;
  }

  function installOperationalRows(items,range,{initialize=false}={}){
    const previousDefault=new Set(state.defaultLiveStatuses||[]);
    const statusWasDefault=sameSet(state.topFilters.Estado||new Set(),previousDefault)&&sameSet(state.columnSelections.status||new Set(),previousDefault);
    state.raw=items;
    state.current=currentSnapshot(items);
    state.meta={apiTotal:items.length,uniqueTotal:state.current.length};
    state.loadedRange={...range};
    buildFilterUniverse();
    if(initialize){
      state.colFilters={};state.columnSelections={};state.textFilters={};
      resetDefaultStatusFilter();
    }else{
      const newDefault=new Set((state.filterValues.Estado||[]).filter(v=>isLiveStatus(v)));
      state.defaultLiveStatuses=newDefault;
      if(statusWasDefault){
        state.topFilters.Estado=new Set(newDefault);
        state.columnSelections.status=new Set(newDefault);
      }
    }
    buildAllMultis();
    buildColumns();
    applyFilters();
    loadAnalyticsYesterdayToday(false);
  }

  async function loadAllOperativo(forceRefresh=false){
    if(state.loading)return;
    if(state.backgroundLoading){
      showToast('La actualización futura todavía está corriendo en segundo plano.');
      return;
    }
    ensureOperationalDates();
    state.taskHistoryCache.clear();
    $('#btnRefresh').disabled=true;
    const previous={raw:state.raw,current:state.current,filtered:state.filtered,meta:state.meta,loadedRange:{...state.loadedRange}};
    const fullRange=currentRange();
    const segments=segmentedOperationalRanges();
    let initialized=state.raw.length>0;

    // Si existe una copia completa reciente, se muestra mientras se refresca el tramo crítico.
    if(!forceRefresh&&!state.raw.length){
      const cached=loadOperationalCache(fullRange);
      if(cached){
        installOperationalRows(cached.items,fullRange,{initialize:true});
        initialized=true;
        $('#loadStatus').textContent=`Cache local ${new Date(cached.savedAt).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})} · actualizando…`;
      }
    }

    // V22.16: sólo bloquea el tramo operativo prioritario -2 / +2 días.
    const firstSeg=segments[0];
    setLoading(true,'Cargando operación actual…',`${firstSeg.from} → ${firstSeg.to}`,25);
    try{
      const first=await loadOneOperationalRange(firstSeg,forceRefresh);
      let merged=mergeOperationalRows(first.items);
      installOperationalRows(merged,{from:firstSeg.from,to:firstSeg.to},{initialize:!initialized});
      initialized=true;
      state.analyticsRaw=state.raw;
      state.analyticsRange={from:firstSeg.from,to:firstSeg.to};
      renderDailyStatePanel();
      $('#loadStatus').textContent='Operativo actual listo · completando futuro…';
      loadControlStatus(false);

      // Desde aquí la página queda utilizable: se retira el overlay.
      setLoading(false);
      state.backgroundLoading=true;

      // No se espera esta promesa: futuro cercano y lejano corren detrás.
      (async()=>{
        const failures=[];
        try{
          for(let i=1;i<segments.length;i++){
            const seg=segments[i];
            $('#loadStatus').textContent=i===1
              ? 'Operativo listo · cargando futuro cercano en segundo plano…'
              : 'Operativo listo · cargando programación futura en segundo plano…';
            try{
              const part=await loadOneOperationalRange(seg,forceRefresh);
              merged=mergeOperationalRows(merged,part.items);
              installOperationalRows(merged,{from:firstSeg.from,to:seg.to},{initialize:false});
            }catch(e){
              failures.push(`${seg.label}: ${e.message}`);
              console.warn('Segmento operativo incompleto',seg,e);
            }
            // Ceder un ciclo de UI ayuda a que filtros, scroll y clicks sigan fluidos.
            await new Promise(r=>setTimeout(r,50));
          }

          saveOperationalCache(fullRange,merged,merged.length);
          state.loadedRange={...fullRange};
          state.analyticsRaw=state.raw;
          state.analyticsRange={...fullRange};
          renderDailyStatePanel();
          $('#loadStatus').textContent=`Actualizado ${new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}`;

          if(failures.length){
            showToast(`Operativo actual disponible. No se pudo completar ${failures.length} tramo(s) futuro(s); podés reintentar con Actualizar.`,9000);
          }else{
            showToast(`Operativo completo: ${merged.length.toLocaleString('es-AR')} intervenciones → ${state.current.length.toLocaleString('es-AR')} tareas únicas.`);
          }
        }finally{
          state.backgroundLoading=false;
          $('#btnRefresh').disabled=false;
        }
      })();
    }catch(e){
      state.raw=previous.raw;state.current=previous.current;state.filtered=previous.filtered;state.meta=previous.meta;state.loadedRange=previous.loadedRange;
      renderAll();
      setLoading(false);
      $('#btnRefresh').disabled=false;
      showToast(`No se pudo cargar la operación actual (${firstSeg.from} → ${firstSeg.to}): ${e.message}.`,10000);
    }
  }

  function getValue(r,key){const map={Estado:statusEs(r.Estado||r.status),Contratista:contractor(r),Arbol:tree(r),Capa:capa(r),SubCapa:subcapa(r),Tipif:siglaTarea(r),Afectacion:affected(r)};return norm(map[key]);}
  function availableRows(){return state.current.filter(passesExclusions);}
  function buildFilterUniverse(){const rows=availableRows();for(const key of ['Estado','Contratista','Arbol','Capa','SubCapa','Tipif','Afectacion'])state.filterValues[key]=[...new Set(rows.map(r=>getValue(r,key)).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es',{numeric:true,sensitivity:'base'}));}
  function resetDefaultStatusFilter(){const live=(state.filterValues.Estado||[]).filter(v=>isLiveStatus(v));const fallback=(state.filterValues.Estado||[]).filter(v=>!['completed','cancelled','notdone'].includes(statusKey(v)));state.defaultLiveStatuses=new Set(live.length?live:fallback);state.topFilters.Estado=new Set(state.defaultLiveStatuses);state.colFilters.Estado=new Set();state.columnSelections.status=new Set(state.defaultLiveStatuses);}
  function selectedLabel(key,set){const all=state.filterValues[key]||[];if(!set||set.size===0)return'Todos';if(key==='Estado'&&state.defaultLiveStatuses?.size&&set.size===state.defaultLiveStatuses.size&&[...set].every(v=>state.defaultLiveStatuses.has(v)))return`Abiertos (${set.size})`;if(set.size===all.length)return'Todos';if(set.size===1)return[...set][0];return`${set.size} seleccionados`;}

  function syncTopAndColumnFilter(source,key,bag){
    if(source==='top'){
      const colKey=TOP_TO_COLUMN[key];
      if(!colKey)return;
      const target=state.columnSelections[colKey] instanceof Set?state.columnSelections[colKey]:(state.columnSelections[colKey]=new Set());
      target.clear();for(const v of bag)target.add(v);
      document.querySelector(`[data-filter-key="${colKey}"]`)?._refresh?.();
    }else{
      const topKey=COLUMN_TO_TOP[key];
      if(!topKey)return;
      const target=state.topFilters[topKey] instanceof Set?state.topFilters[topKey]:(state.topFilters[topKey]=new Set());
      target.clear();for(const v of bag)target.add(v);
      document.getElementById({Estado:'topEstado',Contratista:'topContratista',Arbol:'topArbol',Capa:'topCapa',SubCapa:'topSubCapa',Tipif:'topTipif',Afectacion:'topAfectacion'}[topKey]||'')?._refresh?.();
    }
  }

  function makeMulti(hostId,key,scope){
    const host=document.getElementById(hostId);if(!host)return;host.innerHTML='';const wrap=document.createElement('div');wrap.className='multi';const btn=document.createElement('button');btn.type='button';const panel=document.createElement('div');panel.className='multi-panel hidden';
    const store=scope==='top'?state.topFilters:state.colFilters;if(!(store[key] instanceof Set))store[key]=new Set();const bag=store[key];
    const tools=document.createElement('div');tools.className='multi-tools';tools.innerHTML='<input type="search" placeholder="Buscar…"><button type="button" data-a="toggle">Todos</button><button type="button" class="multi-close" data-a="close" aria-label="Cerrar filtro">×</button>';
    const list=document.createElement('div');list.className='multi-list';panel.append(tools,list);wrap.append(btn,panel);host.append(wrap);
    const render=()=>{btn.textContent=selectedLabel(key,bag);const q=norm(tools.querySelector('input').value).toLowerCase();const vals=(state.filterValues[key]||[]).filter(v=>!q||v.toLowerCase().includes(q));list.innerHTML=vals.length?vals.map(v=>`<label class="multi-option"><input type="checkbox" value="${esc(v)}" ${bag.has(v)?'checked':''}><span>${esc(v)}</span></label>`).join(''):'<div class="multi-empty">Sin valores</div>';const toggleBtn=tools.querySelector('[data-a="toggle"]');const allSelected=vals.length>0&&vals.every(v=>bag.has(v));if(toggleBtn)toggleBtn.textContent=allSelected?'Ninguno':'Todos';list.querySelectorAll('input').forEach(i=>i.onchange=()=>{i.checked?bag.add(i.value):bag.delete(i.value);syncTopAndColumnFilter(scope,key,bag);btn.textContent=selectedLabel(key,bag);render();state.page=1;applyFilters();});};
    btn.onclick=e=>{e.stopPropagation();document.querySelectorAll('.multi-panel').forEach(p=>{if(p!==panel)p.classList.add('hidden')});panel.classList.toggle('hidden');if(!panel.classList.contains('hidden'))render();};tools.querySelector('input').oninput=render;tools.querySelectorAll('button').forEach(b=>b.onclick=e=>{e.stopPropagation();if(b.dataset.a==='close'){panel.classList.add('hidden');return;}const vals=(state.filterValues[key]||[]);const allSelected=vals.length>0&&vals.every(v=>bag.has(v));if(allSelected)bag.clear();else vals.forEach(v=>bag.add(v));syncTopAndColumnFilter(scope,key,bag);render();state.page=1;applyFilters();});host._refresh=render;
  }
  function buildAllMultis(){for(const [id,key] of [['topEstado','Estado'],['topContratista','Contratista'],['topArbol','Arbol'],['topCapa','Capa'],['topSubCapa','SubCapa'],['topTipif','Tipif'],['colStatus','Estado'],['colContractor','Contratista'],['colAffected','Afectacion'],['colCapa','Capa'],['colSubcapa','SubCapa'],['colTipif','Tipif'],['colTree','Arbol']])makeMulti(id,key,id.startsWith('top')?'top':'col');}

  function rowSearchText(r){return [taskId(r),node(r),tech(r),parentEvent(r),eventCode(r),contractor(r),capa(r),subcapa(r),siglaTarea(r),r.AddressLine1,r.address].map(norm).join(' ').toLowerCase();}
  function rowValueByColumn(r,key){switch(key){case'task':return taskId(r);case'created':return formatDate(createdValue(r));case'priority':return priority(r);case'node':return node(r);case'tipif':return siglaTarea(r);case'tipificacion':return norm(r.TipificacionTarea||r['Tipificacion Tarea']);case'status':return statusEs(r.Estado||r.status);case'capa':return capa(r);case'subcapa':return subcapa(r);case'capaSubcapa':return [capa(r),subcapa(r)].filter(Boolean).join(' / ');case'origin':return origin(r);case'affected':return affected(r);case'parentEvent':return parentEvent(r);case'event':return oracleEvent(r)||parentEvent(r);case'eventSigla':return eventSigla(r);case'ageDays':return ageDays(r);case'contractor':return contractor(r);case'scheduled':return formatDateOnly(scheduled(r));case'startTime':return formatDate(startValue(r));case'endTime':return formatDate(endValue(r));case'tech':return tech(r);case'resource':return resource(r);case'tree':return tree(r);default:return'';}}
  function buildColumnValueCache(){
    const rows=availableRows();state.columnValueCache={};
    for(const [key] of COLUMN_DEFS){
      state.columnValueCache[key]=[...new Set(rows.map(r=>String(rowValueByColumn(r,key)??'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es',{numeric:true,sensitivity:'base'}));
    }
  }
  function columnFilterLabel(key){const bag=state.columnSelections[key];if(!bag||bag.size===0)return'Todos';const vals=state.columnValueCache[key]||[];if(bag.size===vals.length)return'Todos';if(bag.size===1)return[...bag][0];return`${bag.size} selecc.`;}
  function makeExcelColumnFilter(host,key){
    host.innerHTML='';host.dataset.filterKey=key;const wrap=document.createElement('div');wrap.className='multi excel-multi';const btn=document.createElement('button');btn.type='button';btn.className='excel-filter-btn';const panel=document.createElement('div');panel.className='multi-panel hidden excel-panel';
    const bag=state.columnSelections[key] instanceof Set?state.columnSelections[key]:(state.columnSelections[key]=new Set());
    panel.innerHTML='<div class="multi-tools"><input type="search" placeholder="Buscar valores…"><button type="button" data-a="toggle">Todos</button><button type="button" class="multi-close" data-a="close" aria-label="Cerrar filtro">×</button></div><div class="multi-list"></div>';
    const search=panel.querySelector('input'),list=panel.querySelector('.multi-list');wrap.append(btn,panel);host.append(wrap);
    const render=()=>{btn.textContent=`${columnFilterLabel(key)} ▾`;const q=norm(search.value).toLowerCase();let vals=(state.columnValueCache[key]||[]).filter(v=>!q||v.toLowerCase().includes(q));const total=vals.length;vals=vals.slice(0,350);list.innerHTML=vals.map(v=>`<label class="multi-option"><input type="checkbox" value="${esc(v)}" ${bag.has(v)?'checked':''}><span>${esc(v)}</span></label>`).join('')+(total>350?`<div class="multi-empty">Mostrando 350 de ${total}. Escribí para buscar.</div>`:'')||'<div class="multi-empty">Sin valores</div>';const toggleBtn=panel.querySelector('[data-a="toggle"]');const allVals=state.columnValueCache[key]||[];const allSelected=allVals.length>0&&allVals.every(v=>bag.has(v));if(toggleBtn)toggleBtn.textContent=allSelected?'Ninguno':'Todos';list.querySelectorAll('input').forEach(i=>i.onchange=()=>{i.checked?bag.add(i.value):bag.delete(i.value);syncTopAndColumnFilter('column',key,bag);btn.textContent=`${columnFilterLabel(key)} ▾`;render();state.page=1;applyFilters();});};
    btn.onclick=e=>{e.stopPropagation();document.querySelectorAll('.multi-panel').forEach(p=>{if(p!==panel)p.classList.add('hidden')});panel.classList.toggle('hidden');if(!panel.classList.contains('hidden')){render();search.focus();}};
    search.oninput=render;panel.querySelectorAll('button').forEach(b=>b.onclick=e=>{e.stopPropagation();if(b.dataset.a==='close'){panel.classList.add('hidden');return;}const allVals=state.columnValueCache[key]||[];const allSelected=allVals.length>0&&allVals.every(v=>bag.has(v));if(allSelected)bag.clear();else allVals.forEach(v=>bag.add(v));syncTopAndColumnFilter('column',key,bag);render();state.page=1;applyFilters();});host._refresh=render;render();
  }
  function applyFilters(){
    const q=norm($('#opSearch').value).toLowerCase();let rows=availableRows();
    rows=rows.filter(r=>{if(q&&!rowSearchText(r).includes(q))return false;for(const key of ['Estado','Contratista','Arbol','Capa','SubCapa','Tipif']){const bag=state.topFilters[key];if(bag?.size&&!bag.has(getValue(r,key)))return false;}for(const key of ['Estado','Contratista','Afectacion','Capa','SubCapa','Tipif','Arbol']){const bag=state.colFilters[key];if(bag?.size&&!bag.has(getValue(r,key)))return false;}for(const [k,bag] of Object.entries(state.columnSelections)){if(bag?.size&&!bag.has(String(rowValueByColumn(r,k)??'').trim()))return false;}for(const [k,v] of Object.entries(state.textFilters)){if(v&&!String(rowValueByColumn(r,k)).toLowerCase().includes(v.toLowerCase()))return false;}return true;});
    if(state.sort.key){const {key,direction}=state.sort;const sortVal=r=>key==='created'?(parseDate(createdValue(r))?.getTime()||0):key==='scheduled'?(parseDate(scheduled(r))?.getTime()||0):rowValueByColumn(r,key);rows.sort((a,b)=>compare(sortVal(a),sortVal(b))*direction);}state.filtered=rows;state.page=1;renderAll();
  }
  function compare(a,b){const na=Number(a),nb=Number(b);if(Number.isFinite(na)&&Number.isFinite(nb))return na-nb;return String(a??'').localeCompare(String(b??''),'es',{numeric:true,sensitivity:'base'});}
  function resetFilters(){$('#opSearch').value='';state.textFilters={};$$('[data-text-col]').forEach(i=>i.value='');for(const k of ['Contratista','Arbol','Capa','SubCapa','Tipif'])state.topFilters[k]=new Set();state.topFilters.Estado=new Set(state.defaultLiveStatuses);state.colFilters={};state.columnSelections={status:new Set(state.defaultLiveStatuses)};buildAllMultis();buildColumns();applyFilters();}

  function movementDate(r){
    for(const v of [endValue(r),startValue(r),r.FechaEfectiva,r.fecha_intervencion,r.FechaIntervencion,r.Agendado,r.date]){
      const d=parseDate(v);if(d)return d;
    }
    return null;
  }
  function localDayKey(d){return d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`:'';}
  function movementRowsForDailyState(){
    const q=norm($('#opSearch').value).toLowerCase();
    return (state.analyticsRaw.length?state.analyticsRaw:state.raw).filter(r=>{
      if(!passesExclusions(r))return false;
      if(q&&!rowSearchText(r).includes(q))return false;
      for(const key of ['Contratista','Arbol','Capa','SubCapa','Tipif']){
        const bag=state.topFilters[key];if(bag?.size&&!bag.has(getValue(r,key)))return false;
      }
      for(const key of ['Contratista','Afectacion','Capa','SubCapa','Tipif','Arbol']){
        const bag=state.colFilters[key];if(bag?.size&&!bag.has(getValue(r,key)))return false;
      }
      for(const [k,bag] of Object.entries(state.columnSelections)){if(k==='status')continue;if(bag?.size&&!bag.has(String(rowValueByColumn(r,k)??'').trim()))return false;}
      for(const [k,v] of Object.entries(state.textFilters)){
        if(k==='status')continue;
        if(v&&!String(rowValueByColumn(r,k)).toLowerCase().includes(v.toLowerCase()))return false;
      }
      return true;
    });
  }
  function renderDailyStatePanel(){
    const tbody=$('#dailyStateTbody');if(!tbody)return;
    const now=new Date();const todayKey=localDayKey(now);const yesterday=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1);const yesterdayKey=localDayKey(yesterday);
    const fmtDay=d=>d.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'});
    $('#dailyTodayHead').textContent=`Hoy ${fmtDay(now)}`;$('#dailyYesterdayHead').textContent=`Ayer ${fmtDay(yesterday)}`;
    const rows=movementRowsForDailyState();
    const defs=[['completed','Completados'],['suspended','Suspendidos'],['cancelled','Cancelados'],['notdone','No realizados']];
    const buckets=new Map(defs.map(([k])=>[k,{today:new Set(),yesterday:new Set()}]));
    for(const r of rows){
      const d=movementDate(r);if(!d)continue;const day=localDayKey(d);if(day!==todayKey&&day!==yesterdayKey)continue;
      const k=statusKey(r.Estado||r.status);const target=buckets.get(k);if(!target)continue;const id=taskId(r)||`${resource(r)}|${d.getTime()}|${k}`;
      if(day===todayKey)target.today.add(id);else target.yesterday.add(id);
    }
    const display=defs.map(([k,label])=>[k,label,buckets.get(k).yesterday.size,buckets.get(k).today.size]);
    tbody.innerHTML=display.map(([key,label,y,t])=>`<tr class="state-${key}"><td><span class="daily-state-label">${esc(label)}</span></td><td class="daily-num ${y===0?'daily-state-zero':''}">${y}</td><td class="daily-num ${t===0?'daily-state-zero':''}">${t}</td></tr>`).join('');
    const completed=display[0]||['completed','Completados',0,0];
    $('#dailyStateSummary').textContent=`Completados: Ayer ${completed[2]} · Hoy ${completed[3]}`;
  }

  function renderAll(){renderKpis();renderDailyStatePanel();renderTable();updateMap();}
  function computeKpis(){const rows=state.filtered;const count=p=>rows.filter(p).length,unique=p=>new Set(rows.filter(p).map(taskId)).size;const eventDays=r=>{const x=taskEventDate(r);return x?Math.max(0,(Date.now()-x.getTime())/86400000):null};const ages=rows.map(ageDays).filter(Number.isFinite);const oldest=ages.length?Math.max(...ages):0;const layer=r=>capa(r).toLowerCase();return [
    ['Tickets Abiertos',count(r=>isLiveStatus(r.Estado||r.status)),''],['Tareas +72hs',count(r=>ageDays(r)>=3),'age-red'],['Tareas 48–72hs',count(r=>ageDays(r)>=2&&ageDays(r)<3),'age-yellow'],['Tarea más antigua',`${Math.floor(oldest)} días`,''],['Caídas nodo',unique(r=>['VFF','FMR'].includes(siglaTarea(r))),''],['Caídas Edif',unique(r=>siglaTarea(r)==='VFE'),''],['Ingress',unique(r=>['EDF','LDI','LIH','LII','EDI'].includes(siglaTarea(r))),''],['Fibra',unique(r=>layer(r).includes('fibra')),'capa-fibra'],['Red + Energía',unique(r=>layer(r).includes('usac')),'capa-usac'],['Infra',unique(r=>layer(r)==='infra'),'capa-infra'],['Edificio',unique(r=>layer(r)==='edificio'),'capa-edificio'],['Eventos +2d',count(r=>(eventDays(r)??-1)>=2),''],['Eventos +3d',count(r=>(eventDays(r)??-1)>=3),''],['Eventos +7d',count(r=>(eventDays(r)??-1)>=7),'']];}
  function renderKpis(){state.kpiValues=computeKpis();$('#kpiStrip').innerHTML=state.kpiValues.map(([l,v,c])=>`<article class="kpi ${c}"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div></article>`).join('');}


  function buildColumns(){const hr=$('#taskHeaderRow'),fr=$('#taskFilterRow');hr.innerHTML='';fr.innerHTML='';buildColumnValueCache();for(const [key,label] of COLUMN_DEFS){const th=document.createElement('th');th.dataset.column=key;th.textContent=label;th.title='Click para ordenar';th.style.cursor='pointer';th.onclick=()=>{if(state.sort.key===key)state.sort.direction*=-1;else state.sort={key,direction:1};applyFilters();};hr.append(th);const fh=document.createElement('th');fh.dataset.column=key;const host=document.createElement('div');host.className='multi-host';fh.append(host);fr.append(fh);makeExcelColumnFilter(host,key);}buildColumnChooser();applyColumnVisibility();}

  function buildColumnChooser(){const p=$('#columnChooserPanel');p.innerHTML=`<div class="column-chooser-actions"><button id="colsAll" class="btn ghost small">Todas</button><button id="colsEss" class="btn ghost small">Esenciales</button><button id="colsClose" class="btn ghost small chooser-close">Cerrar ×</button></div>${COLUMN_DEFS.map(([k,l])=>`<label><input class="col-check" type="checkbox" value="${k}" ${state.hiddenColumns.has(k)?'':'checked'}><span>${esc(l)}</span></label>`).join('')}`;p.querySelectorAll('.col-check').forEach(i=>i.onchange=()=>{i.checked?state.hiddenColumns.delete(i.value):state.hiddenColumns.add(i.value);applyColumnVisibility();});$('#colsAll').onclick=e=>{e.preventDefault();state.hiddenColumns.clear();buildColumnChooser();applyColumnVisibility();};$('#colsEss').onclick=e=>{e.preventDefault();state.hiddenColumns=new Set(COLUMN_DEFS.map(x=>x[0]).filter(k=>!ESSENTIAL_COLUMNS.has(k)));buildColumnChooser();applyColumnVisibility();};$('#colsClose').onclick=e=>{e.preventDefault();$('#columnChooser').open=false;};}
  function applyColumnVisibility(){for(const [k] of COLUMN_DEFS)document.querySelectorAll(`[data-column="${k}"]`).forEach(el=>el.classList.toggle('col-hidden',state.hiddenColumns.has(k)));}

  function createdAgeHours(r){const d=parseDate(createdValue(r));return d?Math.max(0,(Date.now()-d.getTime())/3600000):null;}
  function createdClass(r){const h=createdAgeHours(r);if(h===null)return'';return h<=24?'created-green':h<48?'created-yellow':'created-old';}

  function renderTable(){const total=state.filtered.length,pages=Math.max(1,Math.ceil(total/PAGE_SIZE));if(state.page>pages)state.page=pages;const start=(state.page-1)*PAGE_SIZE,rows=state.filtered.slice(start,start+PAGE_SIZE);$('#opPageLabel').textContent=`Página ${state.page} de ${pages}`;$('#opCountLabel').textContent=`${total.toLocaleString('es-AR')} visibles · ${state.meta.apiTotal.toLocaleString('es-AR')} intervenciones · ${state.meta.uniqueTotal.toLocaleString('es-AR')} tareas únicas`;$('#opPrev').disabled=state.page<=1;$('#opNext').disabled=state.page>=pages;const tb=$('#opTbody');if(!rows.length){tb.innerHTML=`<tr><td colspan="${COLUMN_DEFS.length}" class="empty">Sin resultados con los filtros actuales</td></tr>`;return;}tb.innerHTML=rows.map(r=>`<tr data-task="${esc(taskId(r))}">${COLUMN_DEFS.map(([k])=>`<td data-column="${k}" class="${k==='ageDays'?`age-cell ${ageClass(ageDays(r))}`:''} ${k==='created'?`created-cell ${createdClass(r)}`:''} ${(k==='capa'||k==='capaSubcapa')?`capa-cell ${capaClass(capa(r))}`:''}">${cellHtml(r,k)}</td>`).join('')}</tr>`).join('');applyColumnVisibility();tb.querySelectorAll('tr[data-task]').forEach(tr=>tr.onclick=()=>openTaskDrawer(tr.dataset.task));}
  function cellHtml(r,k){if(k==='task')return`<span class="task-link">${esc(taskId(r))}</span>`;if(k==='status')return badgeStatus(r.Estado||r.status);if(k==='affected')return affected(r)?`<span class="badge ${/^SI$/i.test(affected(r))?'warn':'ok'}">${esc(affected(r))}</span>`:'—';return esc(fmt(rowValueByColumn(r,k)));}

  function taskHistoryFromDate(id,cur){
    const direct=parseDate(createdValue(cur));
    if(direct)return localDayKey(direct);
    const m=String(id||'').trim().match(/^(\d{2})(\d{2})(\d{2})/);
    if(m){const yy=2000+Number(m[1]),mm=Number(m[2]),dd=Number(m[3]);const d=new Date(yy,mm-1,dd);if(d.getFullYear()===yy&&d.getMonth()===mm-1&&d.getDate()===dd)return localDayKey(d);}
    const d=new Date();d.setDate(d.getDate()-90);return localDayKey(d);
  }
  function todayLocalKey(){return localDayKey(new Date());}
  function historyTerminalRank(r){
    const k=statusKey(r.Estado||r.estado||r.status);
    if(k==='cancelled')return 4;
    if(k==='completed')return 3;
    if(k==='notdone')return 2;
    return 0;
  }
  function historySort(rows){
    return [...rows].sort((a,b)=>{
      const t=interventionTimestamp(b)-interventionTimestamp(a);
      if(t)return t;
      const tr=historyTerminalRank(b)-historyTerminalRank(a);
      if(tr)return tr;
      return 0;
    });
  }
  function historyIdentity(r){
    const aid=norm(r.activityId||r.ActivityID||r.activity_id);
    if(aid)return `A:${aid}`;
    return ['C',taskId(r),statusKey(r.Estado||r.estado||r.status),String(interventionTimestamp(r)),resource(r),tech(r)].join('|');
  }
  function mergeHistoryRows(...groups){
    const map=new Map();
    for(const rows of groups){
      for(const r of (rows||[])){
        const key=historyIdentity(r);
        if(!map.has(key))map.set(key,{...r});
        else map.set(key,{...map.get(key),...r});
      }
    }
    return historySort([...map.values()]);
  }
  function historyCounters(rows){
    const c={started:0,suspended:0,assigned:0,enroute:0,scheduled:0,completed:0,cancelled:0,notdone:0,other:0};
    for(const r of rows){const k=statusKey(r.Estado||r.estado||r.status);c[k]=(c[k]||0)+1;}
    return c;
  }
  function renderTaskDrawer(id,cur,hist,{loading=false,error='',sources=''}={}){
    let ordered=historySort(hist||[]);
    const currentKey=statusKey(cur.Estado||cur.status);
    if(['cancelled','completed','notdone'].includes(currentKey)){
      ordered=ordered.sort((a,b)=>{
        const am=statusKey(a.Estado||a.estado||a.status)===currentKey?1:0;
        const bm=statusKey(b.Estado||b.estado||b.status)===currentKey?1:0;
        if(am!==bm)return bm-am;
        return 0;
      });
    }
    const c=historyCounters(ordered);
    const summary=[
      ['Estado actual',statusEs(cur.Estado||cur.status)],['Creado Tableau',formatDate(createdValue(cur))],['Nodo',node(cur)],
      ['Contratista',contractor(cur)],['Técnico',tech(cur)],['Afectación',affected(cur)],['Prioridad',priority(cur)],
      ['Veces suspendida',loading?'…':c.suspended],['Veces iniciada',loading?'…':c.started]
    ];
    const currentCard=`<div class="visit current-live"><div class="visit-card"><div class="visit-top">${badgeStatus(cur.Estado||cur.status)}<strong>Estado actual operativo</strong></div><div class="visit-times"><b>Start:</b> ${esc(formatDate(startValue(cur)))} · <b>End:</b> ${esc(formatDate(endValue(cur)))} · <b>Agendado:</b> ${esc(formatDateOnly(scheduled(cur)))}</div><div class="visit-meta">${esc(fmt(tech(cur)))} · ${esc(fmt(contractor(cur)))} · ${esc(fmt(tree(cur)))} · ${esc(fmt(node(cur)))}</div>${norm(cur.XA_Activity_Notes||cur.activityNotes||cur.closure_notes)?`<div class="notes">${esc(cur.XA_Activity_Notes||cur.activityNotes||cur.closure_notes)}</div>`:''}</div></div>`;
    const timeline=ordered.map((x,i)=>`<div class="visit"><div class="visit-card"><div class="visit-top">${badgeStatus(x.Estado||x.estado||x.status)}<strong>${i===0?'Última intervención':'Intervención'}</strong></div><div class="visit-times"><b>Fecha:</b> ${esc(formatDate(x.FechaIntervencion||x.FechaEfectiva||x.fecha_intervencion||x.date))} · <b>Start:</b> ${esc(formatDate(startValue(x)))} · <b>End:</b> ${esc(formatDate(endValue(x)))} · <b>Agendado:</b> ${esc(formatDateOnly(scheduled(x)))}</div><div class="visit-meta">${esc(fmt(tech(x)))} · ${esc(fmt(contractor(x)))} · ${esc(fmt(tree(x)))} · ${esc(fmt(node(x)))}</div>${norm(x.XA_Activity_Notes||x.activityNotes||x.closure_notes)?`<div class="notes">${esc(x.XA_Activity_Notes||x.activityNotes||x.closure_notes)}</div>`:''}</div></div>`).join('');
    const sourceText=sources?`<div class="history-source">Fuente histórica: ${esc(sources)}</div>`:'';
    const historyBody=loading?'<div class="empty">Consultando Oracle + D1…</div>':error?`<div class="empty">Histórico parcial/no disponible: ${esc(error)}</div>${timeline}`:(timeline||'<div class="empty">No se encontraron intervenciones anteriores para esta tarea.</div>');
    $('#drawerTitle').textContent=id;
    $('#drawerBody').innerHTML=`<div class="detail-grid">${summary.map(([k,v])=>`<div class="detail-item"><div class="k">${esc(k)}</div><div class="v">${esc(fmt(v))}</div></div>`).join('')}</div><h3 class="history-title">Estado actual</h3><div class="timeline">${currentCard}</div><h3 class="history-title">Histórico de intervenciones</h3>${sourceText}<div class="timeline">${historyBody}</div>`;
  }
  async function fetchTaskHistoryD1(id,cur){
    const url=new URL(`${C.HISTORICO_BASE_URL}/api/historico`);
    url.searchParams.set('from',taskHistoryFromDate(id,cur));
    url.searchParams.set('to',todayLocalKey());
    url.searchParams.set('apptNumber',id);
    url.searchParams.set('page','1');
    url.searchParams.set('limit','500');
    const j=await fetchJson(url.toString(),{cache:'no-store'},30000);
    return Array.isArray(j.items)?j.items:[];
  }
  async function fetchTaskHistoryOracle(id,cur){
    const url=new URL(`${C.HISTORICO_BASE_URL}/api/ticket`);
    url.searchParams.set('apptNumber',id);
    url.searchParams.set('from',taskHistoryFromDate(id,cur));
    url.searchParams.set('to',todayLocalKey());
    const j=await fetchJson(url.toString(),{cache:'no-store'},60000);
    return Array.isArray(j.items)?j.items:[];
  }
  async function fetchCombinedTaskHistory(id,cur){
    const cacheKey=upper(id);
    if(state.taskHistoryCache.has(cacheKey))return state.taskHistoryCache.get(cacheKey);
    const promise=(async()=>{
      const [oracleRes,d1Res]=await Promise.allSettled([fetchTaskHistoryOracle(id,cur),fetchTaskHistoryD1(id,cur)]);
      const oracle=oracleRes.status==='fulfilled'?oracleRes.value:[];
      const d1=d1Res.status==='fulfilled'?d1Res.value:[];
      const errors=[];
      if(oracleRes.status==='rejected')errors.push(`Oracle: ${oracleRes.reason?.message||oracleRes.reason}`);
      if(d1Res.status==='rejected')errors.push(`D1: ${d1Res.reason?.message||d1Res.reason}`);
      const merged=mergeHistoryRows(oracle,d1);
      const sources=[oracle.length?'Oracle':'',d1.length?'D1':''].filter(Boolean).join(' + ')||'sin resultados';
      return {items:merged,sources,error:errors.join(' · ')};
    })();
    state.taskHistoryCache.set(cacheKey,promise);
    return promise;
  }
  async function openTaskDrawer(id){
    const local=historyForTask(id),cur=state.current.find(r=>taskId(r)===id)||local[0];if(!cur)return;
    $('#drawer').classList.add('open');$('#drawer').setAttribute('aria-hidden','false');
    renderTaskDrawer(id,cur,[],{loading:true});
    try{
      const result=await fetchCombinedTaskHistory(id,cur);
      renderTaskDrawer(id,cur,result.items,{error:result.error,sources:result.sources});
    }catch(e){
      console.error('Histórico combinado',e);
      renderTaskDrawer(id,cur,[],{error:String(e?.message||e)});
    }
  }
  function closeDrawer(){$('#drawer').classList.remove('open');$('#drawer').setAttribute('aria-hidden','true');}

  function buildMobilesData(){const m=new Map();for(const r of state.filtered){const id=resource(r)||tech(r)||'Sin recurso';if(!m.has(id))m.set(id,{id,name:tech(r)||id,contractor:contractor(r),items:[]});m.get(id).items.push(r);}return [...m.values()].map(g=>{const c=k=>g.items.filter(r=>statusKey(r.Estado||r.status)===k).length;const dates=g.items.map(interventionTimestamp).filter(Boolean);const completed=c('completed');return {...g,tickets:new Set(g.items.map(taskId)).size,completed,suspended:c('suspended'),started:c('started'),assigned:c('assigned'),enroute:c('enroute'),scheduled:c('scheduled'),effectiveness:g.items.length?completed/g.items.length*100:0,first:dates.length?Math.min(...dates):0,last:dates.length?Math.max(...dates):0};}).sort((a,b)=>b.tickets-a.tickets);}
  function renderMobiles(){const q=norm($('#mobileSearch').value).toLowerCase();const rows=buildMobilesData().filter(r=>!q||[r.name,r.id,r.contractor].join(' ').toLowerCase().includes(q));$('#mobilesTbody').innerHTML=rows.length?rows.map(r=>`<tr><td>${esc(r.name)}</td><td>${esc(r.id)}</td><td>${esc(r.contractor)}</td><td class="num">${r.tickets}</td><td class="num">${r.completed}</td><td class="num">${r.suspended}</td><td class="num">${r.started}</td><td class="num">${r.assigned}</td><td class="num">${r.enroute}</td><td class="num">${r.scheduled}</td><td class="num">${r.effectiveness.toFixed(1)}%</td><td>${r.first?esc(formatDate(new Date(r.first).toISOString())):'—'}</td><td>${r.last?esc(formatDate(new Date(r.last).toISOString())):'—'}</td></tr>`).join(''):'<tr><td colspan="13" class="empty">Sin resultados</td></tr>';}
  function buildContractorData(){const m=new Map();for(const r of state.filtered){const name=contractor(r)||'Sin Contratista';if(!m.has(name))m.set(name,{name,items:[],mobiles:new Set()});const g=m.get(name);g.items.push(r);if(resource(r)||tech(r))g.mobiles.add(resource(r)||tech(r));}return [...m.values()].map(g=>{const c=k=>g.items.filter(r=>statusKey(r.Estado||r.status)===k).length;const completed=c('completed');return {...g,tickets:new Set(g.items.map(taskId)).size,completed,suspended:c('suspended'),started:c('started'),assigned:c('assigned'),enroute:c('enroute'),scheduled:c('scheduled'),effectiveness:g.items.length?completed/g.items.length*100:0};}).sort((a,b)=>b.tickets-a.tickets);}
  function renderContractors(){const rows=buildContractorData();$('#contractorsTbody').innerHTML=rows.length?rows.map(r=>`<tr><td>${esc(r.name)}</td><td class="num">${r.mobiles.size}</td><td class="num">${r.tickets}</td><td class="num">${r.completed}</td><td class="num">${r.suspended}</td><td class="num">${r.started}</td><td class="num">${r.assigned}</td><td class="num">${r.enroute}</td><td class="num">${r.scheduled}</td><td class="num">${r.effectiveness.toFixed(1)}%</td></tr>`).join(''):'<tr><td colspan="10" class="empty">Sin resultados</td></tr>';}

  function initMap(){if(state.map)return;state.map=L.map('map').setView(C.DEFAULT_MAP_CENTER||[-34.6037,-58.3816],C.DEFAULT_MAP_ZOOM||10);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(state.map);state.markers=L.featureGroup().addTo(state.map);}
  function updateMap(){if(!$('#mapDetails')?.open)return;initMap();state.markers.clearLayers();for(const r of state.filtered){const lat=Number(r.latitude??r.CoordinateY??r.coordinateY),lng=Number(r.longitude??r.CoordinateX??r.coordinateX);if(!Number.isFinite(lat)||!Number.isFinite(lng))continue;const m=L.marker([lat,lng]).bindPopup(`<strong>${esc(taskId(r))}</strong><br>${esc(node(r))}<br>${esc(tech(r))}<br>${esc(statusEs(r.Estado||r.status))}`);m.on('click',()=>openTaskDrawer(taskId(r)));state.markers.addLayer(m);}const layers=state.markers.getLayers();if(layers.length)state.map.fitBounds(state.markers.getBounds().pad(.08));setTimeout(()=>state.map.invalidateSize(),60);}

  function settingsOpen(){}
  function settingsClose(){}
  function settingsApply(){}
  function settingsReset(){}

  const XL = {
    dark:'162230', white:'FFFFFF', line:'D9E2EC', green:'C6EFCE', greenText:'007D51',
    yellow:'FFEB9C', yellowText:'8A6400', red:'FFC7CE', redText:'9C0006', blue:'D9EAFA',
    fibra:'FFE69A', usac:'D8EFD0', infra:'FFC2CA', gray:'F8FAFC'
  };
  function xlBorder(){return {top:{style:'thin',color:{rgb:XL.line}},bottom:{style:'thin',color:{rgb:XL.line}},left:{style:'thin',color:{rgb:XL.line}},right:{style:'thin',color:{rgb:XL.line}}};}
  function xlBaseStyle(){return {font:{name:'Arial',sz:10,color:{rgb:'17263A'}},alignment:{vertical:'center'},border:xlBorder()};}
  function styleCellForRow(cell,key,r){
    const base=xlBaseStyle();cell.s=base;
    if(key==='created'){
      const cls=createdClass(r);const fill=cls==='created-green'?XL.green:cls==='created-yellow'?XL.yellow:'F4C7AB';
      cell.s={...base,fill:{fgColor:{rgb:fill}},font:{...base.font,bold:true,color:{rgb:cls==='created-green'?XL.greenText:cls==='created-yellow'?XL.yellowText:'7A3F19'}}};
    } else if(key==='ageDays'){
      const a=Number(ageDays(r));const fill=a>=3?XL.red:a>=2?XL.yellow:XL.green;const color=a>=3?XL.redText:a>=2?XL.yellowText:XL.greenText;
      cell.s={...base,fill:{fgColor:{rgb:fill}},font:{...base.font,bold:true,color:{rgb:color}}};
    } else if(key==='status'){
      const k=statusKey(r.Estado||r.status);const map={started:['FFEB9C','815F00'],suspended:['FFD7DC','A12734'],assigned:['DCE9FF','215CAD'],enroute:['D8EEF7','1C617A'],scheduled:['EADCFF','64409B'],completed:['D8F4E6','00734A'],cancelled:['ECE7FF','6038A8']};
      if(map[k])cell.s={...base,fill:{fgColor:{rgb:map[k][0]}},font:{...base.font,bold:true,color:{rgb:map[k][1]}}};
    } else if(key==='capa'){
      const c=capaClass(capa(r));const fill={edificio:XL.blue,fibra:XL.fibra,infra:XL.infra,usac:XL.usac}[c];if(fill)cell.s={...base,fill:{fgColor:{rgb:fill}}};
    } else if(key==='affected'){
      const yes=/^SI$/i.test(affected(r));cell.s={...base,fill:{fgColor:{rgb:yes?XL.yellow:XL.green}},font:{...base.font,bold:true,color:{rgb:yes?XL.yellowText:XL.greenText}}};
    }
  }
  function styleTasksSheet(ws,rows,cols){
    for(let c=0;c<cols.length;c++){
      const addr=XLSX.utils.encode_cell({r:0,c});if(ws[addr])ws[addr].s={fill:{fgColor:{rgb:XL.dark}},font:{name:'Arial',sz:10,bold:true,color:{rgb:XL.white}},alignment:{horizontal:'center',vertical:'center'},border:xlBorder()};
    }
    rows.forEach((r,ri)=>cols.forEach(([key],ci)=>{const cell=ws[XLSX.utils.encode_cell({r:ri+1,c:ci})];if(cell)styleCellForRow(cell,key,r);}));
    ws['!cols']=cols.map(([k,l])=>({wch:Math.max(10,Math.min(28,l.length+6,k==='task'?18:k==='created'?20:k==='scheduled'?13:14))}));
    ws['!autofilter']={ref:`A1:${XLSX.utils.encode_col(Math.max(0,cols.length-1))}${rows.length+1}`};
    ws['!freeze']={xSplit:0,ySplit:1};
  }
  function styleSummarySheet(ws,resumen){
    const range=XLSX.utils.decode_range(ws['!ref']||'A1:A1');
    for(let r=range.s.r;r<=range.e.r;r++)for(let c=range.s.c;c<=range.e.c;c++){const cell=ws[XLSX.utils.encode_cell({r,c})];if(cell)cell.s=xlBaseStyle();}
    const a1=ws['A1'];if(a1)a1.s={fill:{fgColor:{rgb:XL.dark}},font:{name:'Arial',sz:14,bold:true,color:{rgb:XL.white}},alignment:{vertical:'center'}};
    for(let r=0;r<resumen.length;r++){
      const label=String(resumen[r]?.[0]||'');
      if(['Filtro','KPI','Estados ayer y hoy'].includes(label)){
        for(let c=0;c<3;c++){const cell=ws[XLSX.utils.encode_cell({r,c})];if(cell)cell.s={fill:{fgColor:{rgb:XL.dark}},font:{name:'Arial',sz:10,bold:true,color:{rgb:XL.white}},border:xlBorder()};}
      }
      const cell=ws[XLSX.utils.encode_cell({r,c:0})];
      const val=ws[XLSX.utils.encode_cell({r,c:1})];
      if(cell&&/^Tareas \+72hs$/i.test(label)){cell.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.red}}};if(val)val.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.red}},font:{name:'Arial',sz:10,bold:true,color:{rgb:XL.redText}}};}
      if(cell&&/^Tareas 48/i.test(label)){cell.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.yellow}}};if(val)val.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.yellow}},font:{name:'Arial',sz:10,bold:true,color:{rgb:XL.yellowText}}};}
      if(cell&&/^Fibra$/i.test(label)){cell.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.fibra}}};if(val)val.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.fibra}},font:{name:'Arial',sz:10,bold:true}};}
      if(cell&&/^Red \+ Energía$/i.test(label)){cell.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.usac}}};if(val)val.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.usac}},font:{name:'Arial',sz:10,bold:true}};}
      if(cell&&/^Infra$/i.test(label)){cell.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.infra}}};if(val)val.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.infra}},font:{name:'Arial',sz:10,bold:true}};}
      if(cell&&/^Edificio$/i.test(label)){cell.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.blue}}};if(val)val.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.blue}},font:{name:'Arial',sz:10,bold:true}};}
    }
    ws['!cols']=[{wch:28},{wch:32},{wch:18}];
  }
  function kpiBoxType(label){
    if(/\+72/i.test(label))return 'danger';
    if(/48.?72/i.test(label))return 'warning';
    if(/^Caídas /i.test(label))return 'danger';
    if(/^Infra$/i.test(label))return 'danger';
    if(/^Fibra$/i.test(label))return 'fibra';
    if(/^Red \+ Energía$/i.test(label))return 'usac';
    if(/^Edificio$/i.test(label))return 'edificio';
    return 'plain';
  }
  function kpiPalette(label){
    const type=kpiBoxType(label);
    if(type==='danger')return {fill:XL.red,text:XL.redText};
    if(type==='warning')return {fill:XL.yellow,text:XL.yellowText};
    if(type==='fibra')return {fill:XL.fibra,text:'8A6400'};
    if(type==='usac')return {fill:XL.usac,text:'355E3B'};
    if(type==='edificio')return {fill:XL.blue,text:'1F4E79'};
    return {fill:'FFFFFF',text:'17263A'};
  }
  function captureAffectedClass(r){if(/^SI$/i.test(affected(r)))return 'affected-yes'; if(/^NO$/i.test(affected(r)))return 'affected-no'; return ''; }
  function captureStatusPill(r){const k=statusKey(r.Estado||r.status);return `<span class="status-pill ${k}">${esc(statusEs(r.Estado||r.status))}</span>`;}
  function captureCellHtml(r,key){
    if(key==='created'){const cls=createdClass(r);return `<td class="${cls}">${esc(rowValueByColumn(r,'created'))}</td>`;}
    if(key==='affected'){const cls=captureAffectedClass(r);return `<td class="${cls}">${esc(affected(r)||'—')}</td>`;}
    if(key==='priority'){return `<td>${esc(priority(r)||'—')}</td>`;}
    if(key==='status'){return `<td>${captureStatusPill(r)}</td>`;}
    if(key==='ageDays'){const cls=ageClass(ageDays(r));return `<td class="${cls}">${esc(ageDays(r)??'—')}</td>`;}
    if(key==='scheduled'){return `<td>${esc(formatDateOnly(scheduled(r)))}</td>`;}
    const value = key==='task'?taskId(r):key==='node'?node(r):key==='tipif'?siglaTarea(r):key==='subcapa'?subcapa(r):key==='origin'?origin(r):key==='event'?(oracleEvent(r)||parentEvent(r)):key==='parentEvent'?parentEvent(r):key==='contractor'?contractor(r):rowValueByColumn(r,key);
    return `<td>${esc(value)}</td>`;
  }

  function createdTimestamp(r){
    const d=parseDate(createdValue(r));
    return d?d.getTime():0;
  }

  function capturePriorityGroups(rows){
    const red=[],yellow=[],normal=[];
    for(const r of rows){
      const a=Number(ageDays(r));
      if(Number.isFinite(a)&&a>=3)red.push(r);
      else if(Number.isFinite(a)&&a>=2)yellow.push(r);
      else normal.push(r);
    }
    const byAgeThenCreated=(a,b)=>{
      const ad=Number(ageDays(a)),bd=Number(ageDays(b));
      if(Number.isFinite(ad)&&Number.isFinite(bd)&&ad!==bd)return bd-ad;
      return createdTimestamp(a)-createdTimestamp(b);
    };
    red.sort(byAgeThenCreated);
    yellow.sort(byAgeThenCreated);
    normal.sort((a,b)=>createdTimestamp(a)-createdTimestamp(b));
    return {red,yellow,normal};
  }

  function buildCapturePages(rows,pageSize=18){
    const {red,yellow,normal}=capturePriorityGroups(rows);
    const critical=[...red,...yellow];
    const pages=[];

    if(critical.length){
      for(let i=0;i<critical.length;i+=pageSize)pages.push(critical.slice(i,i+pageSize));
      const last=pages[pages.length-1];
      if(last.length<pageSize){
        const needed=pageSize-last.length;
        last.push(...normal.slice(0,needed));
      }
    }else{
      pages.push(normal.slice(0,pageSize));
    }
    return pages.filter(p=>p.length);
  }

  function contractorCaptureCardHtml(contractorName,allRows,previewRows,pageIndex=0,pageCount=1){
    const kpis=computeKpisForRows(allRows);
    const top=kpis.slice(0,7), bottom=kpis.slice(7,14);
    const now=new Date();
    const previewCols=['task','created','affected','priority','node','tipif','status','subcapa','origin','event','parentEvent','ageDays','contractor','scheduled'];
    const previewHeaders=['Tarea','Creado','Afectación','Prioridad','Nodo','Tipif','Estado','Subcapa','Origen','Ticket Evento','Evento Padre','Antigüedad','Contratista','Agendado'];
    const pageText=pageCount>1?` · captura ${pageIndex+1}/${pageCount}`:'';
    return `<div class="export-capture-card excel-like"><div class="export-capture-title">Consulta ETA · ${esc(contractorName)}</div><div class="export-capture-sub">Resumen operativo · ${esc(currentRange().from)} → ${esc(currentRange().to)} · generado ${esc(now.toLocaleString('es-AR'))}${pageText}</div><div class="excel-kpi-grid">${top.map(([l,v])=>`<div class="excel-kpi ${kpiCaptureClass(l)}"><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`).join('')}</div><div class="excel-kpi-grid second">${bottom.map(([l,v])=>`<div class="excel-kpi ${kpiCaptureClass(l)}"><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`).join('')}</div><table class="export-capture-preview"><thead><tr>${previewHeaders.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${previewRows.map(r=>`<tr>${previewCols.map(key=>captureCellHtml(r,key)).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function buildTaskSheetData(rows,cols){
    const kpis=computeKpisForRows(rows);
    const top=kpis.slice(0,7), bottom=kpis.slice(7,14);
    const headerOffset=5;
    const data=[];
    data.push(top.map(([l])=>l));
    data.push(top.map(([,v])=>v));
    data.push(bottom.map(([l])=>l));
    data.push(bottom.map(([,v])=>v));
    data.push(cols.map(x=>x[1]));
    rows.forEach(r=>data.push(cols.map(([k])=>rowValueByColumn(r,k))));
    return {data,headerOffset};
  }
  function styleTasksSheetWithSummary(ws,rows,cols){
    const computed=computeKpisForRows(rows);const {headerOffset}=buildTaskSheetData(rows,cols);
    for(let r=0;r<4;r++) for(let c=0;c<Math.min(7,cols.length);c++){const addr=XLSX.utils.encode_cell({r,c});if(ws[addr]){const label=(r<2?computed.slice(0,7):computed.slice(7,14))[c]?.[0]||'';const pal=kpiPalette(label);ws[addr].s={font:{name:'Arial',sz:r%2===0?9:13,bold:true,color:{rgb:pal.text}},alignment:{horizontal:'center',vertical:'center',wrapText:true},fill:{fgColor:{rgb:pal.fill}},border:xlBorder()};}}
    for(let c=0;c<cols.length;c++){const addr=XLSX.utils.encode_cell({r:headerOffset-1,c});if(ws[addr])ws[addr].s={fill:{fgColor:{rgb:XL.dark}},font:{name:'Arial',sz:10,bold:true,color:{rgb:XL.white}},alignment:{horizontal:'center',vertical:'center'},border:xlBorder()};}
    rows.forEach((r,ri)=>cols.forEach(([key],ci)=>{const cell=ws[XLSX.utils.encode_cell({r:headerOffset+ri,c:ci})];if(cell)styleCellForRow(cell,key,r);}));
    ws['!rows']=[{hpt:24},{hpt:24},{hpt:24},{hpt:24},{hpt:20}];
    ws['!cols']=cols.map(([k,l],idx)=>({wch:Math.max(idx<7?16:10,Math.min(28,l.length+6,k==='task'?18:k==='created'?20:k==='scheduled'?13:14))}));
    ws['!autofilter']={ref:`A${headerOffset}:${XLSX.utils.encode_col(Math.max(0,cols.length-1))}${rows.length+headerOffset}`};
    ws['!freeze']={xSplit:0,ySplit:headerOffset};
  }

  function buildSummaryRows(rows, contractorName='Todos'){
    const filterSummary=[
      ['Contratista',contractorName],
      ['Ventana operativa desde',currentRange().from],
      ['Ventana operativa hasta',currentRange().to],
      ['Búsqueda',$('#opSearch').value||''],
      ['Estado',selectedLabel('Estado',state.topFilters.Estado)],
      ['Árbol',selectedLabel('Arbol',state.topFilters.Arbol)],
      ['Capa',selectedLabel('Capa',state.topFilters.Capa)],
      ['SubCapa',selectedLabel('SubCapa',state.topFilters.SubCapa)],
      ['Tipif',selectedLabel('Tipif',state.topFilters.Tipif)]
    ];
    const kpis=computeKpisForRows(rows).map(([l,v])=>[l,v]);
    const daily=contractorName==='Todos' ? dailyStateExportRows() : dailyStateExportRowsForContractor(contractorName);
    return [
      ['CONSULTA ETA - RESUMEN OPERATIVO'],[],
      ['Filtro','Valor'],...filterSummary,[],
      ['KPI','Valor'],...kpis,[],
      ['Estados ayer y hoy','Ayer','Hoy'],...daily
    ];
  }
  function appendSummarySheetXlsx(wb,rows,contractorName='Todos'){
    const resumen=buildSummaryRows(rows,contractorName);
    const ws=XLSX.utils.aoa_to_sheet(resumen);
    styleSummarySheet(ws,resumen);
    XLSX.utils.book_append_sheet(wb,ws,'Resumen KPI');
    return ws;
  }

  function kpiCaptureClass(label){
    if(/\+72/i.test(label))return'age-red';
    if(/48.?72/i.test(label))return'age-yellow';
    if(/^Caídas /i.test(label))return'kpi-danger';
    if(/^Fibra$/i.test(label))return'capa-fibra';
    if(/^Red \+ Energía$/i.test(label))return'capa-usac';
    if(/^Infra$/i.test(label))return'capa-infra';
    if(/^Edificio$/i.test(label))return'capa-edificio';
    return'';
  }
  async function makeContractorDashboardImages(contractorName,rows){
    if(typeof html2canvas==='undefined')return [];
    const pages=buildCapturePages(rows,18);
    const images=[];
    for(let i=0;i<pages.length;i++){
      const host=document.createElement('div');host.className='export-capture-host';
      host.innerHTML=contractorCaptureCardHtml(contractorName,rows,pages[i],i,pages.length);
      document.body.appendChild(host);
      try{
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const canvas=await html2canvas(host,{backgroundColor:'#f4f7fb',scale:1.35,useCORS:true,logging:false});
        images.push(canvas.toDataURL('image/png'));
      }finally{host.remove();}
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    return images;
  }

  function excelJsArgb(hex){return 'FF'+String(hex).replace('#','').toUpperCase();}
  function excelColName(n){let s='';while(n>0){n--;s=String.fromCharCode(65+(n%26))+s;n=Math.floor(n/26);}return s;}
  function excelJsFill(hex){return {type:'pattern',pattern:'solid',fgColor:{argb:excelJsArgb(hex)}};}
  function excelJsThinBorder(){const c={argb:'FFD9E2EC'};return {top:{style:'thin',color:c},bottom:{style:'thin',color:c},left:{style:'thin',color:c},right:{style:'thin',color:c}};}
  function excelJsApplyTaskCellStyle(cell,key,r){
    cell.font={name:'Arial',size:10,color:{argb:'FF17263A'}};cell.alignment={vertical:'middle'};cell.border=excelJsThinBorder();
    if(key==='created'){
      const cls=createdClass(r),fill=cls==='created-green'?'C6EFCE':cls==='created-yellow'?'FFEB9C':'F4C7AB';cell.fill=excelJsFill(fill);cell.font={name:'Arial',size:10,bold:true,color:{argb:excelJsArgb(cls==='created-green'?'007D51':cls==='created-yellow'?'8A6400':'7A3F19')}};
    } else if(key==='ageDays'){
      const a=Number(ageDays(r)),fill=a>=3?'FFC7CE':a>=2?'FFEB9C':'C6EFCE',color=a>=3?'9C0006':a>=2?'8A6400':'007D51';cell.fill=excelJsFill(fill);cell.font={name:'Arial',size:10,bold:true,color:{argb:excelJsArgb(color)}};
    } else if(key==='status'){
      const map={started:['FFEB9C','815F00'],suspended:['FFD7DC','A12734'],assigned:['DCE9FF','215CAD'],enroute:['D8EEF7','1C617A'],scheduled:['EADCFF','64409B'],completed:['D8F4E6','00734A'],cancelled:['ECE7FF','6038A8']};const m=map[statusKey(r.Estado||r.status)];if(m){cell.fill=excelJsFill(m[0]);cell.font={name:'Arial',size:10,bold:true,color:{argb:excelJsArgb(m[1])}};}
    } else if(key==='affected'){
      const yes=/^SI$/i.test(affected(r));cell.fill=excelJsFill(yes?'FFEB9C':'C6EFCE');cell.font={name:'Arial',size:10,bold:true,color:{argb:excelJsArgb(yes?'8A6400':'007D51')}};
    }
  }
  async function buildContractorWorkbookExcelJS(contractorName,rows,cols,pngBase64=null){
    const wb=new ExcelJS.Workbook();wb.creator='Consulta ETA';wb.created=new Date();
    const ws=wb.addWorksheet('Tareas',{views:[{state:'frozen',ySplit:5}]});
    ws.columns=cols.map(([k,l],idx)=>({key:k,width:Math.max(idx<7?16:11,Math.min(28,l.length+6,k==='task'?19:k==='created'?21:k==='scheduled'?14:15))}));
    const kpis=computeKpisForRows(rows),top=kpis.slice(0,7),bottom=kpis.slice(7,14);
    const writeKpiRow=(rowNum,items,isValue=false)=>{items.forEach(([label,val],idx)=>{const cell=ws.getRow(rowNum).getCell(idx+1);cell.value=isValue?val:label;const pal=kpiPalette(label);cell.fill=excelJsFill(pal.fill);cell.font={name:'Arial',size:isValue?13:9,bold:true,color:{argb:excelJsArgb(pal.text)}};cell.alignment={horizontal:'center',vertical:'middle',wrapText:true};cell.border=excelJsThinBorder();});};
    writeKpiRow(1,top,false);writeKpiRow(2,top,true);writeKpiRow(3,bottom,false);writeKpiRow(4,bottom,true);
    const hr=ws.getRow(5);cols.forEach(([k,l],i)=>hr.getCell(i+1).value=l);hr.height=22;hr.eachCell(cell=>{cell.fill=excelJsFill('162230');cell.font={name:'Arial',size:10,bold:true,color:{argb:'FFFFFFFF'}};cell.alignment={horizontal:'center',vertical:'middle'};cell.border=excelJsThinBorder();});
    rows.forEach(r=>{const row=ws.addRow(Object.fromEntries(cols.map(([k])=>[k,rowValueByColumn(r,k)])));cols.forEach(([k],i)=>excelJsApplyTaskCellStyle(row.getCell(i+1),k,r));});
    ws.autoFilter=`A5:${excelColName(cols.length)}${Math.max(5,rows.length+5)}`;

    const rs=wb.addWorksheet('Resumen KPI');
    rs.getColumn(1).width=28;rs.getColumn(2).width=22;rs.getColumn(3).width=18;
    const resumen=buildSummaryRows(rows,contractorName);
    const startRow=2;
    resumen.forEach((arr,idx)=>{const row=rs.getRow(startRow+idx);arr.forEach((v,ci)=>row.getCell(ci+1).value=v);for(let ci=1;ci<=3;ci++){const cell=row.getCell(ci);cell.border=excelJsThinBorder();cell.font={name:'Arial',size:10,color:{argb:'FF17263A'}};}const label=String(arr?.[0]||'');if(['Filtro','KPI','Estados ayer y hoy'].includes(label)){for(let ci=1;ci<=3;ci++){const cell=row.getCell(ci);cell.fill=excelJsFill('162230');cell.font={name:'Arial',size:10,bold:true,color:{argb:'FFFFFFFF'}};}}});
    return wb;
  }

  function buildStyledTasksWorkbook(rows,cols,title='CONSULTA ETA - OPERATIVO'){
    const wb=XLSX.utils.book_new();
    const built=buildTaskSheetData(rows,cols);
    const ws=XLSX.utils.aoa_to_sheet(built.data);styleTasksSheet(ws,rows,cols);XLSX.utils.book_append_sheet(wb,ws,'Tareas');
    appendSummarySheetXlsx(wb,rows,'Todos');
    return wb;
  }
  function exportTasks(){
    if(typeof XLSX==='undefined'){showToast('No se pudo cargar la librería Excel.');return;}
    const cols=visibleColumnDefs();if(!cols.length||!state.filtered.length){showToast('No hay datos visibles para exportar.');return;}
    const wb=buildStyledTasksWorkbook(state.filtered,cols);
    const d=new Date(),stamp=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    XLSX.writeFile(wb,`Operativo_ETA_${stamp}.xlsx`,{cellStyles:true});
  }
  function visibleColumnDefs(){return COLUMN_DEFS.filter(([k])=>!state.hiddenColumns.has(k));}
  function excelSheetName(name,used){let base=String(name||'Sin Contratista').replace(/[\\\/?*\[\]:]/g,' ').trim().slice(0,31)||'Sin Contratista',n=1,out=base;while(used.has(out)){const suf=`_${n++}`;out=(base.slice(0,31-suf.length)+suf);}used.add(out);return out;}
  function dailyStateExportRows(){const now=new Date(),todayKey=localDayKey(now),y=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1),yKey=localDayKey(y);const defs=[['completed','Completados'],['suspended','Suspendidos'],['cancelled','Cancelados'],['notdone','No realizados']];const m=new Map(defs.map(([k,l])=>[k,{label:l,t:new Set(),y:new Set()}]));for(const r of movementRowsForDailyState()){const d=movementDate(r);if(!d)continue;const dk=localDayKey(d);if(dk!==todayKey&&dk!==yKey)continue;const b=m.get(statusKey(r.Estado||r.status));if(!b)continue;(dk===todayKey?b.t:b.y).add(taskId(r));}return defs.map(([k])=>[m.get(k).label,m.get(k).y.size,m.get(k).t.size]);}
  function computeKpisForRows(rows){
    const count=p=>rows.filter(p).length,unique=p=>new Set(rows.filter(p).map(taskId)).size;
    const eventDays=r=>{const x=taskEventDate(r);return x?Math.max(0,(Date.now()-x.getTime())/86400000):null};
    const ages=rows.map(ageDays).filter(Number.isFinite);
    const oldest=ages.length?Math.max(...ages):0;
    const layer=r=>capa(r).toLowerCase();
    return [
      ['Tickets Abiertos',count(r=>isLiveStatus(r.Estado||r.status)),''],
      ['Tareas +72hs',count(r=>ageDays(r)>=3),''],
      ['Tareas 48–72hs',count(r=>ageDays(r)>=2&&ageDays(r)<3),''],
      ['Tarea más antigua',`${Math.floor(oldest)} días`,''],
      ['Caídas nodo',unique(r=>['VFF','FMR'].includes(siglaTarea(r))),''],
      ['Caídas Edif',unique(r=>siglaTarea(r)==='VFE'),''],
      ['Ingress',unique(r=>['EDF','LDI','LIH','LII','EDI'].includes(siglaTarea(r))),''],
      ['Fibra',unique(r=>layer(r).includes('fibra')),''],
      ['Red + Energía',unique(r=>layer(r).includes('usac')),''],
      ['Infra',unique(r=>layer(r)==='infra'),''],
      ['Edificio',unique(r=>layer(r)==='edificio'),''],
      ['Eventos +2d',count(r=>(eventDays(r)??-1)>=2),''],
      ['Eventos +3d',count(r=>(eventDays(r)??-1)>=3),''],
      ['Eventos +7d',count(r=>(eventDays(r)??-1)>=7),'']
    ];
  }

  function dailyStateExportRowsForContractor(contractorName){
    const now=new Date(),todayKey=localDayKey(now),y=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1),yKey=localDayKey(y);
    const defs=[['completed','Completados'],['suspended','Suspendidos'],['cancelled','Cancelados'],['notdone','No realizados']];
    const m=new Map(defs.map(([k,l])=>[k,{label:l,t:new Set(),y:new Set()}]));
    const cname=String(contractorName||'Sin Contratista');
    for(const r of movementRowsForDailyState()){
      if((contractor(r)||'Sin Contratista')!==cname)continue;
      const d=movementDate(r);if(!d)continue;const dk=localDayKey(d);if(dk!==todayKey&&dk!==yKey)continue;
      const b=m.get(statusKey(r.Estado||r.status));if(!b)continue;(dk===todayKey?b.t:b.y).add(taskId(r));
    }
    return defs.map(([k])=>[m.get(k).label,m.get(k).y.size,m.get(k).t.size]);
  }

  function safeFilePart(value){
    return String(value||'Sin_Contratista').trim().replace(/[\/:*?"<>|]/g,'_').replace(/\s+/g,'_').slice(0,80)||'Sin_Contratista';
  }

  function buildContractorWorkbook(contractorName,rows,cols){
    const wb=XLSX.utils.book_new();
    const built=buildTaskSheetData(rows,cols);
    const ws=XLSX.utils.aoa_to_sheet(built.data);styleTasksSheet(ws,rows,cols);XLSX.utils.book_append_sheet(wb,ws,'Tareas');
    appendSummarySheetXlsx(wb,rows,contractorName);
    return wb;
  }

  async function exportExcelByContractor(){
    if(typeof XLSX==='undefined'){showToast('No se pudo cargar la librería Excel. Revisá la conexión a internet.');return;}
    if(typeof JSZip==='undefined'){showToast('No se pudo cargar la librería ZIP. Revisá la conexión a internet.');return;}
    const cols=visibleColumnDefs();if(!cols.length){showToast('Seleccioná al menos una columna para exportar.');return;}
    if(!state.filtered.length){showToast('No hay tareas visibles para exportar.');return;}

    const groups=new Map();
    for(const r of state.filtered){
      const c=contractor(r)||'Sin Contratista';
      if(!groups.has(c))groups.set(c,[]);
      groups.get(c).push(r);
    }

    const btn=$('#btnExportExcel');
    const oldText=btn?.textContent||'Exportar ZIP por contratista';
    if(btn){btn.disabled=true;btn.textContent='Generando ZIP…';}
    showToast(`Preparando ${groups.size} Excel(s)…`);

    try{
      const zip=new JSZip();
      const d=new Date();
      const stamp=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const sorted=[...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0],'es'));
      let i=0;
      for(const [c,rows] of sorted){
        i++;
        if(btn)btn.textContent=`Excel ${i}/${sorted.length}`;
        let bytes;
        let images=[];
        if(typeof html2canvas!=='undefined'){
          images=await makeContractorDashboardImages(c,rows);
          images.forEach((png,idx)=>{
            const suffix=images.length>1?`_${String(idx+1).padStart(2,'0')}`:'';
            zip.file(`${safeFilePart(c)}_${stamp}${suffix}.png`,png.split(',')[1],{base64:true});
          });
        }
        if(typeof ExcelJS!=='undefined'){
          const wb=await buildContractorWorkbookExcelJS(c,rows,cols,null);
          bytes=await wb.xlsx.writeBuffer();
        }else{
          const wb=buildContractorWorkbook(c,rows,cols);
          bytes=XLSX.write(wb,{bookType:'xlsx',type:'array',cellStyles:true});
        }
        zip.file(`${safeFilePart(c)}_${stamp}.xlsx`,bytes);
        if(i%3===0)await new Promise(resolve=>setTimeout(resolve,0));
      }

      if(btn)btn.textContent='Comprimiendo…';
      const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:6}});
      const a=document.createElement('a');
      a.href=URL.createObjectURL(blob);
      a.download=`Export_Contratistas_${stamp}.zip`;
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(a.href),1500);
      showToast(`ZIP generado: ${groups.size} Excel(s) + capturas prioritarias por contratista`);
    }catch(error){
      console.error(error);
      showToast(`Error al generar ZIP: ${error?.message||error}`);
    }finally{
      if(btn){btn.disabled=false;btn.textContent=oldText;}
    }
  }

  async function loadHistoricoResumen(){try{const today=new Date(),to=today.toISOString().slice(0,10),from=new Date(today.getTime()-90*86400000).toISOString().slice(0,10);const j=await fetchJson(`${C.HISTORICO_BASE_URL}/api/historico/resumen?from=${from}&to=${to}`,{cache:'no-store'});$('#histTotal').textContent=fmt(j.intervenciones);$('#histUnique').textContent=fmt(j.ticketsDistintos);$('#histMin').textContent=from;$('#histMax').textContent=to;}catch(e){showToast(`Histórico: ${e.message}`);}}
  async function loadHistorico(){const from=$('#histFrom').value,to=$('#histTo').value;if(!from||!to){showToast('Indicá desde y hasta');return;}$('#btnHistLoad').disabled=true;try{const u=new URL(`${C.HISTORICO_BASE_URL}/api/historico`);u.searchParams.set('from',from);u.searchParams.set('to',to);u.searchParams.set('page','1');u.searchParams.set('limit',String(C.HISTORICO_PAGE_SIZE||500));if($('#histTree').value.trim())u.searchParams.set('tree',$('#histTree').value.trim());const j=await fetchJson(u,{cache:'no-store'});let rows=j.items||[];const task=upper($('#histTask').value);if(task)rows=rows.filter(r=>upper(taskId(r))===task);state.histData=rows;$('#histStatus').textContent=`${j.total||rows.length} intervenciones`;$('#histTotal').textContent=j.total||rows.length;$('#histUnique').textContent=new Set(rows.map(taskId)).size;$('#histMin').textContent=from;$('#histMax').textContent=to;renderHistorico();}catch(e){$('#histStatus').textContent=`Error: ${e.message}`;showToast(`Histórico: ${e.message}`);}finally{$('#btnHistLoad').disabled=false;}}
  function renderHistorico(){const tb=$('#histTbody'),rows=state.histData;if(!rows.length){tb.innerHTML='<tr><td colspan="11" class="empty">Sin resultados</td></tr>';return;}tb.innerHTML=rows.map(r=>`<tr><td><strong>${esc(taskId(r))}</strong></td><td>${esc(fmt(r.FechaIntervencion||r.fecha_intervencion||r.date))}</td><td>${esc(formatDate(startValue(r)))}</td><td>${esc(formatDate(endValue(r)))}</td><td>${badgeStatus(r.Estado||r.estado||r.status)}</td><td>${esc(tree(r))}</td><td>${esc(node(r))}</td><td>${esc(contractor(r))}</td><td>${esc(tech(r))}</td><td>${esc(affected(r))}</td><td>${esc(eventCode(r))}</td></tr>`).join('');}


  function sideMenuOpen(open=true){
    const menu=$('#sideMenu'),back=$('#sideBackdrop'),btn=$('#btnMenu');if(!menu)return;
    menu.classList.toggle('open',open);menu.setAttribute('aria-hidden',String(!open));back?.classList.toggle('hidden',!open);btn?.setAttribute('aria-expanded',String(open));
  }
  function serializeControlValue(v){return v===null||v===undefined||v===''?'—':String(v);}
  function controlStatusBadge(status){const s=upper(status);const cls=s==='OK'||s==='ACTUALIZADO'?'ok':s==='ERROR'||s==='PENDIENTE'?'warn':'';return `<span class="control-badge ${cls}">${esc(s||'—')}</span>`;}
  function renderControlStatus(j){
    const c=j.control||{},t=j.tableau||{};
    const syncRows=[
      ['Estado',controlStatusBadge(c.estado)],['Último intento',esc(formatLongDateTime(c.ultimoIntento))],['Última actualización exitosa',esc(formatLongDateTime(c.ultimaActualizacionExitosa))],
      ['Registros',esc(serializeControlValue(c.registros))],['Rango',esc(`${serializeControlValue(c.desde)} → ${serializeControlValue(c.hasta)}`)],['Duración',esc(c.duracionSegundos!==undefined&&c.duracionSegundos!==''?`${c.duracionSegundos} s`:'—')],
      ['Fecha último error',esc(formatLongDateTime(c.fechaUltimoError))],['Último error',esc(serializeControlValue(c.ultimoError||c.error))]
    ];
    const pdfRows=[
      ['Estado PDF / caché',controlStatusBadge(t.estado)],['Archivo',esc(serializeControlValue(t.archivo))],['PDF modificado',esc(formatLongDateTime(t.pdfModificado))],
      ['Última actualización real',esc(formatLongDateTime(t.ultimaActualizacionReal))],['¿Hay versión nueva pendiente?',esc(t.hayNuevaVersion===true?'SÍ':t.hayNuevaVersion===false?'NO':'—')],['Registros TABLEAU_CACHE',esc(serializeControlValue(t.registrosCache))]
    ];
    const rowsHtml=arr=>arr.map(([k,v])=>`<div class="control-row"><span>${esc(k)}</span><strong>${v}</strong></div>`).join('');
    $('#controlBody').innerHTML=`<section class="control-section"><h3>Sincronización OFSC → DATA</h3>${rowsHtml(syncRows)}</section><section class="control-section"><h3>Tableau / PDF</h3>${rowsHtml(pdfRows)}</section>`;
    if(c.ultimaActualizacionExitosa)$('#lastUpdate').textContent=`Sync ${formatDate(c.ultimaActualizacionExitosa)}`;
  }
  async function loadControlStatus(showModal=true){
    if(showModal){$('#controlModal').classList.remove('hidden');$('#controlBody').innerHTML='<div class="empty">Consultando CONTROL…</div>';}
    try{
      const u=new URL(C.OPERATIVO_URL);u.searchParams.set('mode','control');u.searchParams.set('refresh','1');
      const j=await fetchJson(u.toString(),{cache:'no-store'},25000);renderControlStatus(j);
    }catch(e){if(showModal)$('#controlBody').innerHTML=`<div class="empty">No se pudo consultar CONTROL: ${esc(e.message||e)}</div>`;}
  }
  document.addEventListener('click',e=>{if(!e.target.closest('.multi'))document.querySelectorAll('.multi-panel').forEach(p=>p.classList.add('hidden'));});
  function flashButton(btn){if(!btn)return;btn.classList.add('pressed');setTimeout(()=>btn.classList.remove('pressed'),180);}
  $('#btnRefresh').onclick=e=>{flashButton(e.currentTarget);loadAllOperativo(true);};
  $('#btnApplyFilters').onclick=e=>{flashButton(e.currentTarget);applyFilters();showToast('Filtros aplicados');};
  $('#btnClearFilters').onclick=e=>{flashButton(e.currentTarget);resetFilters();showToast('Filtros restablecidos');};
  $('#btnToggleMap').onclick=e=>{const d=$('#mapDetails');d.open=!d.open;e.currentTarget.setAttribute('aria-pressed',String(d.open));e.currentTarget.title=d.open?'Ocultar mapa':'Mostrar mapa';flashButton(e.currentTarget);if(d.open)updateMap();};
  $('#mapDetails').addEventListener('toggle',()=>{const open=$('#mapDetails').open;$('#btnToggleMap').setAttribute('aria-pressed',String(open));$('#btnToggleMap').title=open?'Ocultar mapa':'Mostrar mapa';$('#mapSummary').textContent=open?'Visible':'Colapsado';if(open)updateMap();});
  function scrollTaskTableToTop(){const scroller=document.querySelector('.table-scroll');if(scroller)scroller.scrollTo({top:0,behavior:'smooth'});const card=document.querySelector('#subview-tasks');if(card)card.scrollIntoView({block:'start',behavior:'smooth'});}
  $('#opPrev').onclick=()=>{if(state.page>1){state.page--;renderTable();scrollTaskTableToTop();}};$('#opNext').onclick=()=>{const pages=Math.ceil(state.filtered.length/PAGE_SIZE);if(state.page<pages){state.page++;renderTable();scrollTaskTableToTop();}};
  $('#opSearch').oninput=()=>{clearTimeout(state._q);state._q=setTimeout(applyFilters,160);};
  $('#btnExportTasks').onclick=exportTasks;$('#btnExportExcel').onclick=exportExcelByContractor;
  $('#btnMenu').onclick=()=>sideMenuOpen(true);$('#btnMenuClose').onclick=()=>sideMenuOpen(false);$('#sideBackdrop').onclick=()=>sideMenuOpen(false);
  $('#btnControl').onclick=()=>loadControlStatus(true);$('#btnControlClose').onclick=()=>$('#controlModal').classList.add('hidden');
  $$('#controlModal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.add('hidden');}));
  $$('[data-close-drawer]').forEach(x=>x.onclick=closeDrawer);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeDrawer();sideMenuOpen(false);$('#controlModal')?.classList.add('hidden');document.querySelectorAll('.multi-panel').forEach(p=>p.classList.add('hidden'));document.querySelectorAll('.column-chooser').forEach(d=>d.open=false);}});

  loadSavedExclusions();ensureOperationalDates();buildAllMultis();loadAllOperativo();loadControlStatus(false);
})();
