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
    ['task','Tarea'],['created','Creado'],['affected','Afectación'],['mira_up','CM Up %'],['priority','Prioridad'],['node','Nodo'],['tipif','Tipif'],['status','Estado'],
    ['subcapa','Subcapa'],['origin','Origen'],['event','Evento'],['parentEvent','Evento padre'],['parentAgeDays','Antigüedad padre'],['ageDays','Antigüedad tarea (días)'],['eventAgeDays','Antigüedad evento (días)'],['contractor','Contratista'],['scheduled','Agendado'],
    ['tipificacion','Tipificación tarea'],['capa','Capa'],['eventSigla','Sigla Evento'],['startTime','Start Time'],['endTime','End Time'],['tech','Técnico / móvil'],['resource','ID Recurso'],['tree','Árbol'],['suspensiones','Veces suspendida']
  ];
  // Únicamente las métricas que exporta MIRA5 en la planilla simplificada.
  const MIRA_FIELDS = [
    ['mira_total','Total CM','cmStatus.cmTot'],
    ['mira_up','CM Up %','cmStatus.cmUpPercent'],
    ['mira_ofdma','OFDMA %','cmPartialService.ofdmaPercent'],
    ['mira_tecnologia','Tecnología MIRA','equipo.equipoTipo.nombre'],
    ['mira_nodo_cmts','NodoCmts MIRA','nodoCmts'],
    ['mira_tipo','Tipo Nodo MIRA','tipoNodo'],
    ['mira_cmts','CMTS MIRA','cmts']
  ];
  COLUMN_DEFS.push(...MIRA_FIELDS.filter(([k])=>!COLUMN_DEFS.some(([existing])=>existing===k)).map(([k,label])=>[k,label]));
  const INITIAL_VISIBLE_COLUMNS = new Set(['task','created','affected','priority','node','mira_up','tipif','status','subcapa','origin','event','parentEvent','parentAgeDays','contractor','scheduled']);
  const ESSENTIAL_COLUMNS = INITIAL_VISIBLE_COLUMNS;
  const TOP_TO_COLUMN = {Estado:'status',Contratista:'contractor',Arbol:'tree',Capa:'capa',SubCapa:'subcapa',Tipif:'tipif',Afectacion:'affected'};
  const COLUMN_TO_TOP = Object.fromEntries(Object.entries(TOP_TO_COLUMN).map(([k,v])=>[v,k]));

  const PREF_KEY='ofsc_preferences_v2261';
  const savedPrefs=(()=>{try{return JSON.parse(localStorage.getItem(PREF_KEY)||'{}')||{}}catch{return {}}})();
  const savePreferences=()=>{try{localStorage.setItem(PREF_KEY,JSON.stringify({visibleColumns:COLUMN_DEFS.map(([k])=>k).filter(k=>!state.hiddenColumns.has(k)),tableZoom:state.tableZoom,historyZoom:state.historyZoom}));}catch(e){console.warn('No se pudo guardar preferencias',e)}};
  const mira = {summary:new Map(),full:new Map(), last:null, inFlight:false, timer:null, selected: new Set()};
  const state = {
    tab:C.DEFAULT_TAB||'operativo', subtab:'tasks', raw:[], analyticsRaw:[], current:[], filtered:[], page:1, ingresoDayKey:null, ingresoLabel:null, dailyCompletedDayKey:null,
    meta:{apiTotal:0,uniqueTotal:0}, filterValues:{}, topFilters:{}, colFilters:{}, textFilters:{},
    defaultLiveStatuses:new Set(), map:null, markers:null, histData:[], loading:false, hiddenColumns:new Set(COLUMN_DEFS.map(x=>x[0]).filter(k=>Array.isArray(savedPrefs.visibleColumns)?!savedPrefs.visibleColumns.includes(k):!INITIAL_VISIBLE_COLUMNS.has(k))),
    exclusions:cloneDefaults(), sort:{key:'created',direction:1}, columnSelections:{}, columnColorSelections:{}, columnValueCache:{}, kpiValues:[], activeKpis:new Map(),
    loadedRange:{from:'',to:''}, analyticsRange:{from:'',to:''}, taskHistoryCache:new Map(), backgroundLoading:false, tableZoom:[80,90,100,110,120,130,140,150,160].includes(Number(savedPrefs.tableZoom))?Number(savedPrefs.tableZoom):90, historyZoom:[85,100,115,130].includes(Number(savedPrefs.historyZoom))?Number(savedPrefs.historyZoom):100
  };

  const norm=v=>String(v??'').trim();
  const upper=v=>norm(v).toUpperCase();
  const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const fmt=v=>(v===null||v===undefined||v==='')?'—':String(v);
  const parseDate=v=>{ if(!v)return null; const raw=String(v).trim(); const d=new Date(raw.includes('T')?raw:raw.replace(' ','T')); return Number.isNaN(d.getTime())?null:d; };
  const formatDate=v=>{const d=parseDate(v);return d?d.toLocaleString('es-AR',{dateStyle:'short',timeStyle:'short'}):fmt(v)};
  // Fechas operativas son días de calendario (YYYY-MM-DD), no instantes UTC.
  // Evita que 2026-10-15T00:00:00Z se muestre como 14/10 en Argentina.
  const formatDateOnly=v=>{
    const raw=norm(v);
    const m=raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|\s|$)/);
    if(m){
      const y=Number(m[1]),mo=Number(m[2]),day=Number(m[3]);
      const valid=new Date(Date.UTC(y,mo-1,day));
      if(valid.getUTCFullYear()===y&&valid.getUTCMonth()===mo-1&&valid.getUTCDate()===day)
        return `${m[3]}/${m[2]}/${m[1]}`;
    }
    const d=parseDate(v);
    return d?d.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric'}):fmt(v);
  };
  const formatLongDateTime=v=>{const d=parseDate(v);return d?d.toLocaleString('es-AR',{weekday:'long',day:'2-digit',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):fmt(v)};
  const showToast=(m,ms=4200)=>{const t=$('#toast');t.textContent=m;t.classList.remove('hidden');clearTimeout(showToast._t);showToast._t=setTimeout(()=>t.classList.add('hidden'),ms)};
  function cloneDefaults(){return {contractors:[...DEFAULT_EXCLUSIONS.contractors],eventSiglas:[...DEFAULT_EXCLUSIONS.eventSiglas],taskSiglas:[...DEFAULT_EXCLUSIONS.taskSiglas],statuses:[...DEFAULT_EXCLUSIONS.statuses]};}
  function normalizeList(v){return [...new Set((Array.isArray(v)?v:String(v||'').split(/[,;\n]+/)).map(x=>upper(x)).filter(Boolean))];}

  function statusKey(s){const t=norm(s).toLowerCase();if(/complete|complet/.test(t))return'completed';if(/cancel/.test(t))return'cancelled';if(/notdone|not.?done|no.?realiz/.test(t))return'notdone';if(/suspend/.test(t))return'suspended';if(/start|inici/.test(t))return'started';if(/en.?route|enrut|en.?viaje|travel/.test(t))return'enroute';if(/schedule|agend/.test(t))return'scheduled';if(/pending|asign/.test(t))return'assigned';return'other';}
  function statusEs(s){const k=statusKey(s);return ({completed:'COMPLETADA',cancelled:'CANCELADA',notdone:'NO REALIZADA',suspended:'SUSPENDIDA',started:'INICIADA',assigned:'ASIGNADA',enroute:'ENRUTADA',scheduled:'AGENDADA'})[k]||upper(s)||'—';}
  const isLiveStatus=s=>LIVE_KEYS.has(statusKey(s));
  const statusClass=s=>statusKey(s);
  const badgeStatus=s=>`<span class="badge ${statusClass(s)}">${esc(statusEs(s))}</span>`;
  const eventAgeClass=d=>d===null||d===undefined||d===''?'':Number(d)>=3?'age-red':Number(d)>=2?'age-yellow':'age-green';
  const taskAgeClass=r=>{const days=ageDays(r);if(days===null)return'';if(days<1)return'age-white';if(days<2)return'age-green';if(days<3)return'age-yellow';return'age-red';};
  const capaClass=v=>{const x=norm(v).toLowerCase();if(x.includes('edificio'))return'edificio';if(x.includes('infra'))return'infra';if(x.includes('fibra'))return'fibra';if(x.includes('usac'))return'usac';if(x.includes('ingress'))return'ingress';if(x.includes('leak'))return'leak';return''};
  const subcapaClass=v=>capaClass(v);
  const originClass=v=>{const x=norm(v).toLowerCase();if(x.includes('prevent'))return'preventivo';if(x.includes('extern'))return'externo';if(x.includes('client'))return'cliente';return''};
  const taskId=r=>norm(r.Tarea||r.apptNumber||r.activityId);
  const siglaTarea=r=>norm(r.Tipif||r.SiglaTarea||(taskId(r).match(/^\d{6}([A-Z]{3})/)||[])[1]);
  const oracleEvent=r=>norm(r.TicketEvento||r.XA_Eventticket||r.ticket_evento);
  const parentEvent=r=>norm(r.EventoTableau||r.evento_tableau||r.EventoPadre||r.evento_padre)||oracleEvent(r);
  const eventCode=r=>oracleEvent(r)||parentEvent(r);
  const eventSigla=r=>norm(r.SiglaEvento||r.EventoSigla||(eventCode(r).match(/^\d{6}([A-Z]{2})/)||[])[1]);
  // Creado representa un día calendario cuando CreadoExacto está vacío.
  // No interpretar YYYY-MM-DD como medianoche UTC: en Argentina resta 3 horas.
  const createdValue=r=>r.CreadoExacto||r.creado_exacto||r.Creado||r.creado||'';
  const createdDate=r=>{
    const raw=String(createdValue(r)||'').trim();
    const match=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(match){
      const y=Number(match[1]),m=Number(match[2]),day=Number(match[3]);
      const d=new Date(y,m-1,day,12,0,0);
      return d.getFullYear()===y&&d.getMonth()===m-1&&d.getDate()===day?d:null;
    }
    return parseDate(raw);
  };
  const createdDisplay=r=>{
    const exact=String(r.CreadoExacto||r.creado_exacto||'').trim();
    if(exact)return formatDate(exact);
    const raw=String(r.Creado||r.creado||'').trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return formatDateOnly(raw);
    return formatDate(raw);
  };
  const startValue=r=>r.StartTime||r.startTime||r.start_time||'';
  const endValue=r=>r.EndTime||r.endTime||r.end_time||'';
  const interventionTimestamp=r=>{for(const v of [endValue(r),startValue(r),r.FechaEfectiva,r.fecha_intervencion,r.FechaIntervencion,r.Agendado,r.date]){const d=parseDate(v);if(d)return d.getTime();}return 0;};
  const serialCount=v=>{if(v===null||v===undefined||v==='')return 0;if(typeof v==='number')return v;const n=Number(v);if(Number.isFinite(n))return n;const d=parseDate(v);if(d&&d.getUTCFullYear()<=1901){const epoch=Date.UTC(1899,11,30);return Math.round((d.getTime()-epoch)/86400000);}return 0;};
  const suspendedCount=r=>serialCount(r.VecesSuspendida??r.veces_suspendida);
  const totalAssignments=r=>serialCount(r.TotalAsignaciones??r.total_asignaciones);
  const affected=r=>norm(r.Afectacion||r.afectacion);
  const priority=r=>norm(r.XA_Priority||r.Priority||r.Prioridad||r.priority);
  const origin=r=>{
    const p=upper(parentEvent(r));
    if(/^\d{6}MP/.test(p)||/^MP(?:\b|[-_])/.test(p))return 'PREVENTIVO';
    return norm(r.Origen||r.origen);
  };
  const tree=r=>norm(r.Arbol||r.arbol);
  const contractor=r=>{
    const raw=norm(r.Contratista||r.contratista);
    const key=upper(raw).replace(/[ _-]+/g,' ').replace(/\s+/g,' ').trim();
    if(key==='RD CONSTRUCCIONES'||key==='CONSTRUCCIONES RD'||key==='CONSTRUCCIONES RD')return 'CONSTRUCCIONES RD';
    return raw;
  };
  const tech=r=>norm(r.Tecnico||r.resourceName||r.tecnico);
  const resource=r=>norm(r.IDRecurso||r.resourceId||r.id_recurso);
  const capa=r=>norm(r.Capa||r.capa);
  const subcapa=r=>norm(r.SubCapa||r.subcapa);
  const node=r=>norm(r.Nodo||r.nodo);
  const scheduled=r=>r.Agendado||r.agendado||r.date||'';
  // Antigüedades por DÍAS CALENDARIO (Argentina), no bloques móviles de 24 horas.
  const todayCalendarUtc=()=>{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Argentina/Buenos_Aires',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const m=Object.fromEntries(parts.map(p=>[p.type,p.value]));return Date.UTC(Number(m.year),Number(m.month)-1,Number(m.day));};
  const dateAgeDays=d=>{if(!d||Number.isNaN(d.getTime()))return null;const then=Date.UTC(d.getFullYear(),d.getMonth(),d.getDate());return Math.max(0,Math.round((todayCalendarUtc()-then)/86400000));};
  const ticketDateFromCode=code=>{const m=norm(code).match(/^(\d{2})(\d{2})(\d{2})[A-Z]/i);if(!m)return null;const y=2000+Number(m[1]),mo=Number(m[2]),day=Number(m[3]);const d=new Date(y,mo-1,day,12);return d.getFullYear()===y&&d.getMonth()===mo-1&&d.getDate()===day?d:null;};
  const ageDays=r=>dateAgeDays(createdDate(r));
  const eventAgeDays=r=>{const d=taskEventDate(r);return d?dateAgeDays(d):null;};
  const parentAgeDays=r=>{const raw=parentEvent(r);const d=ticketDateFromCode(raw);return d?dateAgeDays(d):null;};

  /*
     ESTADO ACTUAL POR TAREA
     No confiamos en el orden físico de DATA. Una tarea puede tener varias
     intervenciones el mismo día (por ejemplo SUSPENDIDA y luego COMPLETADA).
     El registro actual es el de la intervención más reciente, usando:
       End Time -> Start Time -> FechaEfectiva -> Agendado -> date.
     Si dos registros empatan exactamente, se prioriza un estado terminal
     (COMPLETADA/CANCELADA/NO REALIZADA) y luego el activityId mayor.
  */
  function terminalStatusRank(r){
    const k=statusKey(r.Estado||r.status);
    if(k==='cancelled')return 30;
    if(k==='completed')return 20;
    if(k==='notdone')return 10;
    return 0;
  }

  function realInterventionTimestamp(r){
    // Importante: NO usa Agendado/date como evidencia de que el estado ocurrió.
    // Una cancelación manual puede tener StartTime/EndTime nulos y conservar una
    // fecha de agenda futura. Esa agenda no debe reactivar el ticket.
    for(const v of [endValue(r),startValue(r),r.FechaEfectiva,r.fecha_intervencion,r.FechaIntervencion]){
      const d=parseDate(v);if(d)return d.getTime();
    }
    return 0;
  }

  function chooseNewest(rows){
    return [...rows].sort((a,b)=>{
      const ra=realInterventionTimestamp(a),rb=realInterventionTimestamp(b);
      if(rb!==ra)return rb-ra;
      const ia=Number(a.activityId||a.ActivityID||0),ib=Number(b.activityId||b.ActivityID||0);
      if(Number.isFinite(ia)&&Number.isFinite(ib)&&ib!==ia)return ib-ia;
      return interventionTimestamp(b)-interventionTimestamp(a);
    })[0];
  }

  // Regla operativa: una actividad asignada para una fecha POSTERIOR a hoy
  // se muestra AGENDADA. El estado OFSC y el registro crudo quedan intactos.
  // No aplica a terminales, iniciadas, suspendidas ni enrutadas.
  function operationalStatusForFutureAssignment(r){
    if(statusKey(r.Estado||r.status)!=='assigned')return r;
    const ymd=v=>{
      const raw=norm(v);
      const match=raw.match(/^(\d{4}-\d{2}-\d{2})(?:T|\s|$)/);
      if(match)return match[1];
      const d=parseDate(v);
      return d?localYmd(d):'';
    };
    const when=ymd(r.FechaEfectiva)||ymd(r.Agendado)||ymd(r.date);
    if(!when||when<=localYmd(new Date()))return r;
    return {...r,EstadoOriginalOFSC:r.Estado,statusOriginalOFSC:r.status,Estado:'AGENDADA',status:'scheduled'};
  }

  function currentSnapshot(rows){
    const grouped=new Map();
    for(const r of rows){
      const id=taskId(r);if(!id)continue;
      if(!grouped.has(id))grouped.set(id,[]);
      grouped.get(id).push(r);
    }

    const out=[];
    for(const taskRows of grouped.values()){
      // Un estado terminal encontrado dentro de la ventana cargada manda sobre
      // una asignación/agendamiento futuro. CANCELADA tiene prioridad máxima.
      const terminalRows=taskRows.filter(r=>terminalStatusRank(r)>0);
      if(terminalRows.length){
        terminalRows.sort((a,b)=>{
          const rank=terminalStatusRank(b)-terminalStatusRank(a);
          if(rank)return rank;
          const rb=realInterventionTimestamp(b),ra=realInterventionTimestamp(a);
          if(rb!==ra)return rb-ra;
          return interventionTimestamp(b)-interventionTimestamp(a);
        });
        out.push(terminalRows[0]);
        continue;
      }
      out.push(operationalStatusForFutureAssignment(chooseNewest(taskRows)));
    }
    return out.filter(Boolean);
  }
  function historyForTask(id){return state.raw.filter(r=>taskId(r)===id).sort((a,b)=>interventionTimestamp(b)-interventionTimestamp(a));}
  function taskEventDate(r){return ticketDateFromCode(eventCode(r));}

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
    Ventana total: hoy -7 días hasta hoy +30 días.

    FASE 1 (bloqueante): -7 hasta +3.
    Se divide en 7 segmentos para mantener consultas estables. La tabla NO
    se habilita hasta que los 7 segmentos terminaron y se reconstruyó el
    estado actual por tarea.

    FASE 2 (segundo plano): +4 hasta +30.
    Se consulta sin bloquear al usuario y la tabla se refresca UNA sola vez
    al terminar el bloque futuro.
  */
  function operationalRange(){
    const now=new Date();
    return {
      from:localYmd(shiftLocalDays(now,-3)),
      to:localYmd(shiftLocalDays(now,30))
    };
  }

  function phaseOneOperationalRanges(){
    const now=new Date();
    // 7 segmentos que cubren completamente -7 / +3.
    return [
      {key:'p1_1',label:'Histórico -7/-6',from:localYmd(shiftLocalDays(now,-7)),to:localYmd(shiftLocalDays(now,-6))},
      {key:'p1_2',label:'Histórico -5/-4',from:localYmd(shiftLocalDays(now,-5)),to:localYmd(shiftLocalDays(now,-4))},
      {key:'p1_3',label:'Histórico -3/-2',from:localYmd(shiftLocalDays(now,-3)),to:localYmd(shiftLocalDays(now,-2))},
      {key:'p1_4',label:'Histórico -1/hoy',from:localYmd(shiftLocalDays(now,-1)),to:localYmd(shiftLocalDays(now,0))},
      {key:'p1_5',label:'Futuro +1',from:localYmd(shiftLocalDays(now,1)),to:localYmd(shiftLocalDays(now,1))},
      {key:'p1_6',label:'Futuro +2',from:localYmd(shiftLocalDays(now,2)),to:localYmd(shiftLocalDays(now,2))},
      {key:'p1_7',label:'Futuro +3',from:localYmd(shiftLocalDays(now,3)),to:localYmd(shiftLocalDays(now,3))}
    ];
  }

  function backgroundFutureRanges(){
    const now=new Date();
    return [
      {key:'f1',label:'Futuro +4/+10',from:localYmd(shiftLocalDays(now,4)),to:localYmd(shiftLocalDays(now,10))},
      {key:'f2',label:'Futuro +11/+20',from:localYmd(shiftLocalDays(now,11)),to:localYmd(shiftLocalDays(now,20))},
      {key:'f3',label:'Futuro +21/+30',from:localYmd(shiftLocalDays(now,21)),to:localYmd(shiftLocalDays(now,30))}
    ];
  }

  function ensureOperationalDates(){
    const r=operationalRange();
    const label=$('#opWindowLabel');
    if(label)label.textContent=`${r.from} → ${r.to}  (fijo: -3 / +30 días)`;
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
    u.searchParams.set('sin_notas','1');
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
    u.searchParams.set('sin_notas','1');
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
      La ventana operativa fija (-7/+30) ya contiene ayer y hoy.
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

  function mergeHistoryIntoCurrent(cur,h){
    const out={...cur};
    for(const [k,v] of Object.entries(h||{}))if(v!==undefined&&v!==null&&String(v).trim()!=='')out[k]=v;
    const st=h?.Estado||h?.estado||h?.status;if(norm(st)){out.Estado=statusEs(st);out.status=st;}
    return out;
  }
  function resolveVerifiedHistoryCurrent(cur,history){
    const rows=[cur,...(history||[])].filter(Boolean),term=rows.filter(r=>historyTerminalRank(r)>0);
    if(term.length){return [...term].sort((a,b)=>{const rank=historyTerminalRank(b)-historyTerminalRank(a);if(rank)return rank;const rb=realInterventionTimestamp(b),ra=realInterventionTimestamp(a);if(rb!==ra)return rb-ra;return interventionTimestamp(b)-interventionTimestamp(a);})[0];}
    return [...rows].sort((a,b)=>{const rb=realInterventionTimestamp(b),ra=realInterventionTimestamp(a);if(rb!==ra)return rb-ra;return interventionTimestamp(b)-interventionTimestamp(a);})[0];
  }
  async function verifyOlderThan72AgainstHistory(baseRows,{blocking=false,candidates=null}={}){
    // V22.45:
    // - validar una sola vez sobre las tareas que YA quedaron en la tabla final;
    // - una consulta por taskId;
    // - solo >=3 días;
    // - solo estados operativos/abiertos;
    // - excluir Capa = INFRA;
    // - excluir cancelados/completados/no realizados por isLiveStatus().
    const source=Array.isArray(candidates)?candidates:[];
    const seen=new Set();
    const MAX_HISTORY_CHECKS=100;

    // Primero armamos los candidatos únicos. Luego priorizamos los más antiguos
    // y aplicamos un corte duro: jamás se hacen más de 100 consultas por ciclo.
    const allCandidates=source.filter(r=>{
      const id=taskId(r);
      if(!id||seen.has(id))return false;
      if((ageDays(r)??-1)<3)return false;
      if(!isLiveStatus(r.Estado||r.status))return false;
      if(!passesExclusions(r))return false;
      if(upper(capa(r))==='INFRA')return false;
      seen.add(id);
      return true;
    }).sort((a,b)=>(ageDays(b)||0)-(ageDays(a)||0));

    const totalEligible=allCandidates.length;
    const finalCandidates=allCandidates.slice(0,MAX_HISTORY_CHECKS);

    if(!finalCandidates.length)return {
      rows:baseRows,checked:0,corrected:0,errors:0,totalEligible:0,limitReached:false
    };

    let cursor=0,done=0,errors=0;
    const corrections=[];
    const workers=[];
    // Bajamos concurrencia para no castigar OFSC con ráfagas innecesarias.
    const workerCount=Math.min(2,finalCandidates.length);

    const worker=async()=>{
      while(true){
        const idx=cursor++;
        if(idx>=finalCandidates.length)break;
        const cur=finalCandidates[idx];
        const id=taskId(cur);
        try{
          if(blocking){
            setLoading(
              true,
              'Validando tickets visibles >72 h…',
              `${done+1} de ${finalCandidates.length} · ${id}`,
              92+Math.round((done/finalCandidates.length)*7)
            );
          }else{
            $('#loadStatus').textContent=`Validando ${done+1}/${finalCandidates.length} tickets visibles >72 h${totalEligible>MAX_HISTORY_CHECKS?` · límite ${MAX_HISTORY_CHECKS} de ${totalEligible}`:''}…`;
          }

          const result=await fetchCombinedTaskHistory(id,cur);
          const resolved=resolveVerifiedHistoryCurrent(cur,result.items);

          if(resolved){
            const merged=mergeHistoryIntoCurrent(cur,resolved);
            const changed=
              statusKey(merged.Estado||merged.status)!==statusKey(cur.Estado||cur.status) ||
              realInterventionTimestamp(merged)!==realInterventionTimestamp(cur) ||
              norm(merged.activityId||merged.ActivityID)!==norm(cur.activityId||cur.ActivityID);

            if(changed)corrections.push(merged);
          }
        }catch(e){
          errors++;
          console.warn('Validación histórica OFSC final >72h',id,e);
        }finally{
          done++;
          // Pequeña pausa para evitar ráfagas de consultas.
          await new Promise(r=>setTimeout(r,120));
        }
      }
    };

    for(let i=0;i<workerCount;i++)workers.push(worker());
    await Promise.all(workers);

    return {
      rows:mergeOperationalRows(baseRows,corrections),
      checked:finalCandidates.length,
      corrected:corrections.length,
      errors,
      totalEligible,
      limitReached:totalEligible>MAX_HISTORY_CHECKS
    };
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

  // V22.61: Carga estrictamente bloqueante hasta completar TODOS los segmentos
  // y la verificación histórica final. Nunca publicar un operativo parcial.
  async function loadAllOperativo(forceRefresh=false){
    if(state.loading)return;
    ensureOperationalDates();
    state.taskHistoryCache.clear();
    $('#btnRefresh').disabled=true;
    const previous={raw:state.raw,current:state.current,filtered:state.filtered,meta:state.meta,loadedRange:{...state.loadedRange}};
    const fullRange=currentRange();
    const segments=[{key:'operativo_completo',label:'Todos los árboles · -3/+30',...fullRange}];
    let merged=[];
    setLoading(true,'Cargando operativo completo…',`Preparando ${segments.length} segmentos`,1);
    try{
      for(let i=0;i<segments.length;i++){
        const seg=segments[i];
        setLoading(true,'Consultando operativo y programación futura…',
          `${seg.label} · segmento ${i+1} de ${segments.length}`,
          Math.round(3+(i/segments.length)*82));
        const part=await loadOneOperationalRange(seg,forceRefresh);
        merged=mergeOperationalRows(merged,part.items);
        setLoading(true,'Consultando operativo y programación futura…',
          `${seg.label} completado · ${i+1} de ${segments.length}`,
          Math.round(3+((i+1)/segments.length)*82));
      }

      // Selección de candidatos SIN instalar/renderizar todavía la tabla.
      // Esta función depende de los filtros visibles; se construye el snapshot en memoria.
      setLoading(true,'Preparando verificación final…','Identificando tareas abiertas con antigüedad de 3 días o más',86);
      const candidateSnapshot=currentSnapshot(merged).filter(passesExclusions);
      const verified=await verifyOlderThan72AgainstHistory(merged,{
        blocking:true,candidates:candidateSnapshot
      });
      merged=verified.rows;
      if(verified.limitReached){
        console.warn(`Verificación limitada a 100 de ${verified.totalEligible} candidatos según la política existente.`);
      }
      if(verified.errors){
        throw new Error(`La verificación histórica terminó con ${verified.errors} error(es). No se publican datos parciales.`);
      }

      setLoading(true,'Finalizando operativo…','Actualizando tabla, indicadores y filtros',99);
      installOperationalRows(merged,fullRange,{initialize:!state.raw.length});
      state.analyticsRaw=state.raw;
      state.analyticsRange={...fullRange};
      renderDailyStatePanel();
      saveOperationalCache(fullRange,merged,merged.length);
      $('#loadStatus').textContent=`Actualizado ${new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})} · operativo completo y verificado`;
      showToast(`Operativo completo: ${merged.length.toLocaleString('es-AR')} intervenciones · ${verified.checked} tareas verificadas.`);
    }catch(e){
      // No publicar resultados parciales ni perder la última tabla válida.
      state.raw=previous.raw;state.current=previous.current;state.filtered=previous.filtered;
      state.meta=previous.meta;state.loadedRange=previous.loadedRange;
      renderAll();
      $('#loadStatus').textContent='Error de actualización · último operativo conservado';
      showToast(`No se publicó el operativo: ${e.message}. Reintentá con Actualizar.`,12000);
      console.error('Carga/verificación incompleta',e);
    }finally{
      state.backgroundLoading=false;
      setLoading(false);
      $('#btnRefresh').disabled=false;
    }
  }

  function getValue(r,key){const map={Estado:statusEs(r.Estado||r.status),Contratista:contractor(r),Arbol:tree(r),Capa:capa(r),SubCapa:subcapa(r),Tipif:siglaTarea(r),Afectacion:affected(r)};return norm(map[key]);}
  function availableRows(){return state.current.filter(passesExclusions);}
  function buildFilterUniverse(){const rows=availableRows();for(const key of ['Estado','Contratista','Arbol','Capa','SubCapa','Tipif','Afectacion'])state.filterValues[key]=[...new Set(rows.map(r=>getValue(r,key)).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es',{numeric:true,sensitivity:'base'}));}
  function resetDefaultStatusFilter(){const live=(state.filterValues.Estado||[]).filter(v=>isLiveStatus(v));const fallback=(state.filterValues.Estado||[]).filter(v=>!['completed','cancelled','notdone'].includes(statusKey(v)));state.defaultLiveStatuses=new Set(live.length?live:fallback);state.topFilters.Estado=new Set(state.defaultLiveStatuses);state.colFilters.Estado=new Set();state.columnSelections.status=new Set(state.defaultLiveStatuses);}
  // Sin restricción (Set vacío) equivale a Todos. El centinela permite
  // distinguirlo de una selección manual que dejó cero valores marcados.
  const ETA_NO_VALUES='__ETA_NO_VALUES__';
  function etaAllChecked(bag,values){return !bag.size || (values.length>0 && values.every(v=>bag.has(v)));}
  function etaValueChecked(bag,value){return !bag.size || bag.has(value);}
  function etaToggleValue(bag,value,checked,universe){
    if(!bag.size){universe.forEach(v=>bag.add(v));}
    bag.delete(ETA_NO_VALUES);
    if(checked)bag.add(value);else bag.delete(value);
    if(!bag.size)bag.add(ETA_NO_VALUES);
    else if(universe.length && universe.every(v=>bag.has(v)))bag.clear();
  }
  function etaToggleAll(bag, universe){
    if(etaAllChecked(bag,universe)){bag.clear();bag.add(ETA_NO_VALUES);}
    else bag.clear();
  }
  // Mostrar inmediatamente el estado del botón antes de recalcular la tabla.
  function etaUpdateToggleVisual(button, selected){
    if(!button)return;
    button.classList.toggle('eta-all-active',selected);
    button.setAttribute('aria-pressed',String(selected));
    button.classList.remove('eta-toggle-pulse');
    void button.offsetWidth;
    button.classList.add('eta-toggle-pulse');
  }
  function selectedLabel(key,set){const all=state.filterValues[key]||[];if(!set||set.size===0)return'Todos';if(set.has(ETA_NO_VALUES))return'0 seleccionados';if(key==='Estado'&&state.defaultLiveStatuses?.size&&set.size===state.defaultLiveStatuses.size&&[...set].every(v=>state.defaultLiveStatuses.has(v)))return`Abiertos (${set.size})`;if(set.size===all.length)return'Todos';if(set.size===1)return[...set][0];return`${set.size} seleccionados`;}

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
    const render=()=>{btn.textContent=selectedLabel(key,bag);const q=norm(tools.querySelector('input').value).toLowerCase();const vals=(state.filterValues[key]||[]).filter(v=>!q||v.toLowerCase().includes(q));list.innerHTML=vals.length?vals.map(v=>`<label class="multi-option"><input type="checkbox" value="${esc(v)}" ${etaValueChecked(bag,v)?'checked':''}><span>${esc(v)}</span></label>`).join(''):'<div class="multi-empty">Sin valores</div>';const toggleBtn=tools.querySelector('[data-a="toggle"]');const allSelected=etaAllChecked(bag,state.filterValues[key]||[]);if(toggleBtn){toggleBtn.textContent='Todos';toggleBtn.classList.toggle('eta-all-active',allSelected);toggleBtn.setAttribute('aria-pressed',String(allSelected));}list.querySelectorAll('input').forEach(i=>i.onchange=()=>{etaToggleValue(bag,i.value,i.checked,state.filterValues[key]||[]);syncTopAndColumnFilter(scope,key,bag);btn.textContent=selectedLabel(key,bag);render();state.page=1;applyFilters();});};
    btn.onclick=e=>{e.stopPropagation();closeAllFloatingMenus(panel);panel.classList.toggle('hidden');if(!panel.classList.contains('hidden'))render();};tools.querySelector('input').oninput=render;tools.querySelectorAll('button').forEach(b=>b.onclick=e=>{e.stopPropagation();if(b.dataset.a==='close'){panel.classList.add('hidden');return;}etaToggleAll(bag,state.filterValues[key]||[]);etaUpdateToggleVisual(b,etaAllChecked(bag,state.filterValues[key]||[]));syncTopAndColumnFilter(scope,key,bag);render();state.page=1;setTimeout(applyFilters,0);});host._refresh=render;
  }
  function buildAllMultis(){for(const [id,key] of [['topEstado','Estado'],['topContratista','Contratista'],['topArbol','Arbol'],['topCapa','Capa'],['topSubCapa','SubCapa'],['topTipif','Tipif'],['colStatus','Estado'],['colContractor','Contratista'],['colAffected','Afectacion'],['colCapa','Capa'],['colSubcapa','SubCapa'],['colTipif','Tipif'],['colTree','Arbol']])makeMulti(id,key,id.startsWith('top')?'top':'col');}
  function closeAllFloatingMenus(except=null){
    document.querySelectorAll('.multi-panel').forEach(p=>{if(p!==except)p.classList.add('hidden');});
    for(const el of ['etaIngresoDetails','dailyStateDetails','columnChooser']){
      const d=document.getElementById(el);if(d!==except && d) d.open=false;
    }
  }
  function closeTableFilterPanels(){document.querySelectorAll('.excel-panel').forEach(p=>p.classList.add('hidden'));}


  const COLOR_META={
    white:{label:'Blanco',hex:'#ffffff'},
    green:{label:'Verde',hex:'#c6efce'},
    yellow:{label:'Amarillo',hex:'#ffeb9c'},
    red:{label:'Rojo',hex:'#ffc7ce'},
    salmon:{label:'Rojo',hex:'#f4c7ab'},
    pink:{label:'Rojo',hex:'#ffc2ca'},
    blue:{label:'Celeste',hex:'#d9eafa'},
    lightblue:{label:'Azul',hex:'#dce9ff'},
    cyan:{label:'Celeste claro',hex:'#d8eef7'},
    purple:{label:'Violeta',hex:'#eadcff'},
    violet:{label:'Lila',hex:'#ece7ff'}
  };
  const COLOR_FILTERABLE_KEYS=new Set(['created','affected','node','tipif','status','subcapa','origin','parentEvent','parentAgeDays','ageDays','eventAgeDays','capa','mira_up']);

  function classToColorKey(cls){
    return ({edificio:'blue',fibra:'yellow',infra:'pink',usac:'green',ingress:'purple',leak:'purple'})[cls]||'white';
  }
  function columnColorKey(r,key,dups=null){
    if(key==='mira_up'){const v=miraUpRaw(r);return v===null?'white':v<80?'red':'white';}
    if(key==='created'){
      const c=createdClass(r);return c==='created-green'?'green':c==='created-yellow'?'yellow':c==='created-old'?'salmon':'white';
    }
    if(key==='ageDays'){
      const c=taskAgeClass(r);return c==='age-green'?'green':c==='age-yellow'?'yellow':c==='age-red'?'red':'white';
    }
    if(key==='eventAgeDays'||key==='parentAgeDays'){
      const c=eventAgeClass(key==='parentAgeDays'?parentAgeDays(r):eventAgeDays(r));return c==='age-green'?'green':c==='age-yellow'?'yellow':c==='age-red'?'red':'white';
    }
    if(key==='capa')return classToColorKey(capaClass(capa(r)));
    if(key==='subcapa')return classToColorKey(subcapaClass(subcapa(r)));
    if(key==='origin'){
      const c=originClass(origin(r));return c==='preventivo'?'green':c==='externo'?'pink':'white';
    }
    if(key==='tipif')return ['VFF','FMR','VFE'].includes(upper(siglaTarea(r)))?'red':'white';
    if(key==='affected')return /^SI$/i.test(affected(r))?'yellow':'green';
    if(key==='status'){
      return ({started:'yellow',suspended:'red',assigned:'lightblue',enroute:'cyan',scheduled:'purple',completed:'green',cancelled:'violet'})[statusKey(r.Estado||r.status)]||'white';
    }
    if(key==='node')return dups?.nodes?.has(upper(node(r)))?'green':'white';
    if(key==='parentEvent')return dups?.parents?.has(upper(parentEvent(r)))?'green':'white';
    return 'white';
  }
  function colorOptionsForColumn(key,rows){
    if(!COLOR_FILTERABLE_KEYS.has(key))return[];
    const dups=duplicateSets(rows);
    const used=new Set(rows.map(r=>columnColorKey(r,key,dups)));
    // Los tonos rosa, rojizo y rojo se filtran como una sola categoría Rojo.
    const normalized=new Set([...used].map(k=>['red','salmon','pink'].includes(k)?'red':k));
    return [...normalized].filter(k=>COLOR_META[k]).map(k=>({key:k,...COLOR_META[k]}));
  }
  function valueColorKey(key,value,rows){
    if(!COLOR_FILTERABLE_KEYS.has(key))return '';
    const dups=duplicateSets(rows);
    const target=String(value??'').trim();
    const r=rows.find(x=>String(rowValueByColumn(x,key)??'').trim()===target);
    return r?columnColorKey(r,key,dups):'';
  }

  function rowSearchText(r){return [taskId(r),node(r),tech(r),parentEvent(r),eventCode(r),contractor(r),capa(r),subcapa(r),siglaTarea(r),r.AddressLine1,r.address].map(norm).join(' ').toLowerCase();}
  function rowValueByColumn(r,key){if(key.startsWith('mira_'))return miraValue(r,key);switch(key){case'task':return taskId(r);case'created':return createdDisplay(r);case'priority':return priority(r);case'node':return node(r);case'tipif':return siglaTarea(r);case'tipificacion':return norm(r.TipificacionTarea||r['Tipificacion Tarea']);case'status':return statusEs(r.Estado||r.status);case'capa':return capa(r);case'subcapa':return subcapa(r);case'capaSubcapa':return [capa(r),subcapa(r)].filter(Boolean).join(' / ');case'origin':return origin(r);case'affected':return affected(r);case'parentEvent':return parentEvent(r);case'event':return oracleEvent(r)||parentEvent(r);case'eventSigla':return eventSigla(r);case'ageDays':return ageDays(r);case'eventAgeDays':return eventAgeDays(r);case'parentAgeDays':return parentAgeDays(r);case'contractor':return contractor(r);case'scheduled':return formatDateOnly(scheduled(r));case'startTime':return formatDate(startValue(r));case'endTime':return formatDate(endValue(r));case'tech':return tech(r);case'resource':return resource(r);case'tree':return tree(r);case'suspensiones':return suspendedCount(r);default:return'';}}
  function buildColumnValueCache(){
    const rows=availableRows();state.columnValueCache={};state.columnColorCache={};state.columnColorOptionsCache={};
    const dups=duplicateSets(rows);
    for(const [key] of COLUMN_DEFS){
      state.columnValueCache[key]=[...new Set(rows.map(r=>String(rowValueByColumn(r,key)??'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es',{numeric:true,sensitivity:'base'}));
      if(COLOR_FILTERABLE_KEYS.has(key)){
        const mapping=new Map(),used=new Set();
        for(const r of rows){
          const v=String(rowValueByColumn(r,key)??'').trim();
          const color=columnColorKey(r,key,dups);
          used.add(['red','salmon','pink'].includes(color)?'red':color);
          if(v&&!mapping.has(v))mapping.set(v,color);
        }
        state.columnColorCache[key]=mapping;
        state.columnColorOptionsCache[key]=[...used].filter(c=>COLOR_META[c]).map(c=>({key:c,...COLOR_META[c]}));
      }
    }
  }
  function columnFilterLabel(key){const color=state.columnColorSelections[key];if(color)return `● ${COLOR_META[color]?.label||color}`;const bag=state.columnSelections[key];if(!bag||bag.size===0)return'Todos';if(bag.has(ETA_NO_VALUES))return'0 selecc.';const vals=state.columnValueCache[key]||[];if(bag.size===1)return[...bag][0];return`${bag.size} selecc.`;}
  function makeExcelColumnFilter(host,key){
    host.innerHTML='';host.dataset.filterKey=key;
    const wrap=document.createElement('div');wrap.className='multi excel-multi';
    const btn=document.createElement('button');btn.type='button';btn.className='excel-filter-btn';
    const panel=document.createElement('div');panel.className='multi-panel hidden excel-panel excel-filter-portal';
    const bag=state.columnSelections[key] instanceof Set?state.columnSelections[key]:(state.columnSelections[key]=new Set());
    panel.innerHTML='<div class="multi-tools"><input type="search" placeholder="Buscar valores…"><button type="button" data-a="toggle">Todos</button><button type="button" class="multi-close" data-a="close" aria-label="Cerrar filtro">×</button></div><div class="color-filter-box hidden"></div><div class="multi-list"></div>';
    const search=panel.querySelector('input'),list=panel.querySelector('.multi-list'),colorBox=panel.querySelector('.color-filter-box');
    wrap.append(btn);host.append(wrap);document.body.append(panel);
    const close=()=>panel.classList.add('hidden');
    const place=()=>{
      const r=btn.getBoundingClientRect(),w=Math.min(330,window.innerWidth-16);
      panel.style.position='fixed';panel.style.width=w+'px';
      panel.style.left=Math.max(8,Math.min(r.left,window.innerWidth-w-8))+'px';
      panel.style.zIndex='10000';panel.style.top=(r.bottom+4)+'px';panel.style.bottom='auto';
      panel.style.maxHeight=Math.max(150,window.innerHeight-r.bottom-16)+'px';
    };
    const renderColors=()=>{
      const options=state.columnColorOptionsCache?.[key]||[],selected=state.columnColorSelections[key]||'';
      if(!options.length){colorBox.classList.add('hidden');colorBox.innerHTML='';return;}
      colorBox.classList.remove('hidden');
      colorBox.innerHTML='<div class="color-filter-title">Filtrar por color</div><div class="color-filter-options">'+
        `<button type="button" class="color-filter-chip ${!selected && !bag.size ? 'active' : ''}" data-color=""><span class="color-swatch clear-swatch">×</span>Todos</button>`+
        options.map(o=>`<button type="button" class="color-filter-chip ${selected===o.key?'active':''}" data-color="${esc(o.key)}"><span class="color-swatch" style="background:${o.hex}"></span>${esc(o.label)}</button>`).join('')+
        '</div>';
      colorBox.querySelectorAll('[data-color]').forEach(b=>b.onclick=e=>{
        e.stopPropagation();const color=b.dataset.color||'';
        if(color){
           state.columnColorSelections[key]=color;
           bag.clear();
           delete state.textFilters[key];
           const input=document.querySelector(`[data-text-col="${key}"]`);if(input)input.value='';
           syncTopAndColumnFilter('column',key,bag);
         }else {
           // Todos en colores significa quitar cualquier filtro de ESTA columna.
           delete state.columnColorSelections[key];
           bag.clear();
           delete state.textFilters[key];
           syncTopAndColumnFilter('column',key,bag);
         }
         state.page=1;updateButton();render();applyFilters();
      });
    };
    const updateButton=()=>{
      const color=state.columnColorSelections[key];
      btn.textContent=`${columnFilterLabel(key)} ▾`;
      btn.classList.toggle('has-color-filter',!!color);
      btn.style.setProperty('--selected-filter-color',color?(COLOR_META[color]?.hex||'#fff'):'transparent');
    };
    const render=()=>{
      updateButton();
      const q=norm(search.value).toLowerCase();const activeColor=state.columnColorSelections[key]||'';const colorMap=state.columnColorCache?.[key];let vals=(state.columnValueCache[key]||[]).filter(v=>(!q||v.toLowerCase().includes(q))&&(!activeColor||(['red','pink','salmon'].includes(colorMap?.get(v))?'red':colorMap?.get(v))===activeColor));
      const total=vals.length;vals=vals.slice(0,350);
      list.innerHTML=vals.map(v=>{
        const ck=colorMap?.get(v),meta=COLOR_META[ck];
        const sw=meta?`<span class="filter-value-swatch" style="background:${meta.hex}" title="${esc(meta.label)}"></span>`:'';
        return `<label class="multi-option"><input type="checkbox" value="${esc(v)}" ${!activeColor&&etaValueChecked(bag,v)?'checked':''}>${sw}<span>${esc(v)}</span></label>`;
      }).join('')+(total>350?`<div class="multi-empty">Mostrando 350 de ${total}. Escribí para buscar.</div>`:'')||'<div class="multi-empty">Sin valores</div>';
      const toggleBtn=panel.querySelector('[data-a="toggle"]');
      if(toggleBtn){toggleBtn.textContent='Todos';toggleBtn.classList.toggle('eta-all-active',!activeColor&&etaAllChecked(bag,state.columnValueCache[key]||[]));toggleBtn.setAttribute('aria-pressed',String(!activeColor&&etaAllChecked(bag,state.columnValueCache[key]||[])));}
      list.querySelectorAll('input').forEach(i=>i.onchange=()=>{
        if(activeColor){bag.clear();bag.add(i.value);}else{etaToggleValue(bag,i.value,i.checked,state.columnValueCache[key]||[]);}delete state.columnColorSelections[key];syncTopAndColumnFilter('column',key,bag);render();state.page=1;applyFilters();
      });
      renderColors();
    };
    btn.onclick=e=>{e.stopPropagation();closeAllFloatingMenus(panel);const open=panel.classList.contains('hidden');if(!open){close();return;}render();panel.classList.remove('hidden');place();search.focus();};
    panel.onclick=e=>e.stopPropagation();search.oninput=render;
    panel.querySelector('[data-a="close"]').onclick=e=>{e.stopPropagation();close();};
    panel.querySelector('[data-a="toggle"]').onclick=e=>{e.stopPropagation();
      // Alternar entre todas las casillas y ninguna (sin alterar otros filtros).
      const wasAll=!state.columnColorSelections[key] && etaAllChecked(bag,state.columnValueCache[key]||[]);
      if(wasAll){bag.clear();bag.add(ETA_NO_VALUES);}else{bag.clear();}
      etaUpdateToggleVisual(panel.querySelector('[data-a="toggle"]'),!wasAll);
      delete state.columnColorSelections[key];
      delete state.textFilters[key];
      search.value='';
      syncTopAndColumnFilter('column',key,bag);
      render();state.page=1;setTimeout(applyFilters,0);
    };
    host._refresh=()=>{if(panel.classList.contains('hidden'))updateButton();else render();};updateButton();
  }
  // KPI = filtro local acumulativo: se cruza con los filtros existentes.
  // El rango del KPI Más antigua queda fijado al día observado al pulsarlo.
  function kpiMatches(r,label,threshold){
    const age=ageDays(r),eventAge=eventAgeDays(r),sig=upper(siglaTarea(r)),layer=capa(r).toLowerCase();
    switch(label){
      case 'Abiertos':return isLiveStatus(r.Estado||r.status);
      case '+3 días':return age!==null&&age>=3;
      case '2 días':return age===2;
      case '1 día':return age===1;
      case 'Más antigua':return age===threshold;
      case 'Caídas nodo':return sig==='VFF'||sig==='FMR';
      case 'Caídas Edif':return sig==='VFE';
      case 'Ingress':return ['EDF','LDI','LIH','LII','EDI'].includes(sig);
      case 'Fibra':return layer.includes('fibra');
      case 'Red + Energía':return layer.includes('usac');
      case 'Infra':return layer==='infra';
      case 'Edificio':return layer==='edificio';
      case 'Ev +2d':return eventAge!==null&&eventAge>=2;
      case 'Ev +3d':return eventAge!==null&&eventAge>=3;
      case 'Ev +7d':return eventAge!==null&&eventAge>=7;
      default:return true;
    }
  }
  function applyKpiSelection(rows){
    if(!state.activeKpis.size)return rows;
    return rows.filter(r=>{
      for(const [label,threshold] of state.activeKpis){
        if(!kpiMatches(r,label,threshold))return false;
      }
      return true;
    });
  }
  function toggleKpi(label){
    if(state.activeKpis.has(label))state.activeKpis.delete(label);
    else{
      const days=label==='Más antigua'?state.filtered.map(ageDays).filter(Number.isFinite):[];
      state.activeKpis.set(label,label==='Más antigua'?(days.length?Math.max(...days):0):true);
    }
    applyFilters();
  }
  function applyFilters(){
    // Semántica estable: un nodo/evento duplicado lo es en el operativo completo,
    // incluso si los filtros solo dejan visible una de sus tareas.
    state.duplicateBaseSets=duplicateSets(availableRows());
    if(state.ingresoDayKey || state.dailyCompletedDayKey){
      let rows=state.ingresoDayKey ? ingresoRowsForDay(state.ingresoDayKey) : completedRowsForDay(state.dailyCompletedDayKey);
      if(state.sort.key){const {key,direction}=state.sort;const sortVal=r=>key==='created'?(createdDate(r)?.getTime()||0):key==='scheduled'?(parseDate(scheduled(r))?.getTime()||0):rowValueByColumn(r,key);rows.sort((a,b)=>compare(sortVal(a),sortVal(b))*direction);}
      state.filtered=applyKpiSelection(rows);state.page=1;renderAll();return;
    }
    const q=norm($('#opSearch').value).toLowerCase();let rows=availableRows();
    rows=rows.filter(r=>{if(q&&!rowSearchText(r).includes(q))return false;for(const key of ['Estado','Contratista','Arbol','Capa','SubCapa','Tipif']){const bag=state.topFilters[key];if(bag?.size&&!bag.has(getValue(r,key)))return false;}for(const key of ['Estado','Contratista','Afectacion','Capa','SubCapa','Tipif','Arbol']){const bag=state.colFilters[key];if(bag?.size&&!bag.has(getValue(r,key)))return false;}for(const [k,bag] of Object.entries(state.columnSelections)){if(bag?.size&&!bag.has(String(rowValueByColumn(r,k)??'').trim()))return false;}for(const [k,v] of Object.entries(state.textFilters)){if(v&&!String(rowValueByColumn(r,k)).toLowerCase().includes(v.toLowerCase()))return false;}return true;});
    const dups=state.duplicateBaseSets;
    for(const [k,color] of Object.entries(state.columnColorSelections||{})){
      if(!color)continue;
      const requested=['red','salmon','pink'].includes(color)?'red':color;
      rows=rows.filter(r=>{
        const actual=columnColorKey(r,k,dups);
        return (['red','salmon','pink'].includes(actual)?'red':actual)===requested;
      });
    }
    rows=applyKpiSelection(rows);
    if(state.sort.key){const {key,direction}=state.sort;const sortVal=r=>key==='created'?(createdDate(r)?.getTime()||0):key==='scheduled'?(parseDate(scheduled(r))?.getTime()||0):rowValueByColumn(r,key);rows.sort((a,b)=>compare(sortVal(a),sortVal(b))*direction);}state.filtered=rows;state.page=1;renderAll();
  }
  function compare(a,b){const na=Number(a),nb=Number(b);if(Number.isFinite(na)&&Number.isFinite(nb))return na-nb;return String(a??'').localeCompare(String(b??''),'es',{numeric:true,sensitivity:'base'});}
  function resetFilters(){
    // V23.5: limpieza O( filtros ) sin reconstruir miles de opciones de los menús.
    // Mantener los Set originales: los listeners de los controles capturan su referencia.
    state.ingresoDayKey=null;state.ingresoLabel=null;state.dailyCompletedDayKey=null;
    state.activeKpis.clear();
    $('#opSearch').value='';
    Object.keys(state.textFilters).forEach(k=>delete state.textFilters[k]);
    $$('[data-text-col]').forEach(i=>i.value='');
    Object.values(state.topFilters).forEach(bag=>{if(bag instanceof Set)bag.clear();});
    Object.values(state.colFilters).forEach(bag=>{if(bag instanceof Set)bag.clear();});
    Object.values(state.columnSelections).forEach(bag=>{if(bag instanceof Set)bag.clear();});
    for(const value of state.defaultLiveStatuses){
      if(!(state.topFilters.Estado instanceof Set))state.topFilters.Estado=new Set();
      if(!(state.columnSelections.status instanceof Set))state.columnSelections.status=new Set();
      state.topFilters.Estado.add(value);
      state.columnSelections.status.add(value);
    }
    Object.keys(state.columnColorSelections).forEach(k=>delete state.columnColorSelections[k]);
    // Solo etiquetas: renderizar las listas y colores únicamente al abrir el menú.
    document.querySelectorAll('.multi-panel').forEach(p=>p.classList.add('hidden'));
    document.querySelectorAll('[data-filter-key]').forEach(host=>{
      const btn=host.querySelector('.excel-filter-btn');
      if(btn){const color=state.columnColorSelections[host.dataset.filterKey];btn.textContent=columnFilterLabel(host.dataset.filterKey)+' ▾';btn.classList.toggle('has-color-filter',!!color);btn.style.setProperty('--selected-filter-color',color?(COLOR_META[color]?.hex||'#fff'):'transparent');}
    });
    for(const [id,key,scope] of [
      ['topEstado','Estado','top'],['topContratista','Contratista','top'],
      ['topArbol','Arbol','top'],['topCapa','Capa','top'],
      ['topSubCapa','SubCapa','top'],['topTipif','Tipif','top'],
      ['colStatus','Estado','col'],['colContractor','Contratista','col'],
      ['colAffected','Afectacion','col'],['colCapa','Capa','col'],
      ['colSubcapa','SubCapa','col'],['colTipif','Tipif','col'],['colTree','Arbol','col']
    ]){
      const host=document.getElementById(id);
      const btn=host?.querySelector('.multi > button');
      if(btn)btn.textContent=selectedLabel(key,scope==='top'?state.topFilters[key]:state.colFilters[key]);
    }
    state.page=1;
    applyFilters();
  }

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
  function completedRowsForDay(dayKey){
    return dailyStateRowsForExport('completed',dayKey);
  }
  function dailyDateKey(which){
    const n=new Date();return localDayKey(new Date(n.getFullYear(),n.getMonth(),n.getDate()-(which==='ayer'?1:0)));
  }
  function renderDailyStatePanel(){
    const y=dailyDateKey('ayer'),t=dailyDateKey('hoy');
    const cy=completedRowsForDay(y).length,ct=completedRowsForDay(t).length;
    $('#dailyStateSummary').textContent=`Completados: Ayer ${cy} · Hoy ${ct}`;
    $('#etaCompletedCountAyer').textContent=cy;
    $('#etaCompletedCountHoy').textContent=ct;
    $('#dailyStateDetails').classList.toggle('is-active',!!state.dailyCompletedDayKey);
    $('#btnCompletedYesterday').classList.toggle('selected',state.dailyCompletedDayKey===y);
    $('#btnCompletedToday').classList.toggle('selected',state.dailyCompletedDayKey===t);
  }
  function ingresoRowsForDay(dayKey){
    const currentById=new Map(state.current.map(r=>[taskId(r),r]));
    const unique=new Map();
    for(const r of movementRowsForDailyState()){
      const d=createdDate(r);if(!d||localDayKey(d)!==dayKey)continue;
      const id=taskId(r);if(!id)continue;
      const cur=currentById.get(id)||r;
      if(statusKey(cur.Estado||cur.status)==='cancelled')continue;
      unique.set(id,cur);
    }
    return [...unique.values()];
  }
  function renderIngresoEta(){
    const box=$('#etaIngresoSummary');if(!box)return;
    const now=new Date(), todayKey=localDayKey(now),yesterday=new Date(now.getFullYear(),now.getMonth(),now.getDate()-1),yesterdayKey=localDayKey(yesterday);
    const yesterdayIds=new Set(ingresoRowsForDay(yesterdayKey).map(taskId));
    const todayIds=new Set(ingresoRowsForDay(todayKey).map(taskId));
    box.textContent=`Ingreso ETA: Ayer ${yesterdayIds.size} · Hoy ${todayIds.size}`;
    box.title=`Seleccionar los tickets creados ayer (${yesterdayIds.size}) u hoy (${todayIds.size})`;
    $('#etaIngresoCountAyer').textContent=yesterdayIds.size;
    $('#etaIngresoCountHoy').textContent=todayIds.size;
    const active=!!state.ingresoDayKey;
    $('#etaIngresoDetails').classList.toggle('is-active',active);
    $('#btnEtaIngresoAyer').classList.toggle('selected',state.ingresoLabel==='ayer');
    $('#btnEtaIngresoHoy').classList.toggle('selected',state.ingresoLabel==='hoy');
    $('#opCountLabel').dataset.ingresoMode=active?state.ingresoLabel:'';
  }

  function renderAll(){renderKpis();renderDailyStatePanel();renderIngresoEta();renderTable();updateMap();}
  function computeKpis(){const rows=state.filtered;const count=p=>rows.filter(p).length,unique=p=>new Set(rows.filter(p).map(taskId)).size;const eventDays=r=>eventAgeDays(r);const days=rows.map(ageDays).filter(Number.isFinite);const oldestDays=days.length?Math.max(...days):0;const layer=r=>capa(r).toLowerCase();return [
    ['Abiertos',count(r=>isLiveStatus(r.Estado||r.status)),''],['+3 días',count(r=>(ageDays(r)??-1)>=3),'age-red'],['2 días',count(r=>ageDays(r)===2),'age-yellow'],['1 día',count(r=>ageDays(r)===1),'age-green'],['Más antigua',`${oldestDays} días`,''],['Caídas nodo',unique(r=>['VFF','FMR'].includes(siglaTarea(r))),''],['Caídas Edif',unique(r=>siglaTarea(r)==='VFE'),''],['Ingress',unique(r=>['EDF','LDI','LIH','LII','EDI'].includes(siglaTarea(r))),''],['Fibra',unique(r=>layer(r).includes('fibra')),'capa-fibra'],['Red + Energía',unique(r=>layer(r).includes('usac')),'capa-usac'],['Infra',unique(r=>layer(r)==='infra'),'capa-infra'],['Edificio',unique(r=>layer(r)==='edificio'),'capa-edificio'],['Ev +2d',count(r=>(eventDays(r)??-1)>=2),''],['Ev +3d',count(r=>(eventDays(r)??-1)>=3),''],['Ev +7d',count(r=>(eventDays(r)??-1)>=7),'']];}
  function renderKpis(){
    state.kpiValues=computeKpis();
    $('#kpiStrip').innerHTML=state.kpiValues.map(([l,v,c])=>{
      const active=state.activeKpis.has(l);
      return `<button type="button" class="kpi ${c} ${active?'kpi-selected':''}" data-kpi-label="${esc(l)}" aria-pressed="${active}" title="${esc(l)}: ${esc(v)} · ${active?'Quitar filtro':'Filtrar tickets'}"><span class="l">${esc(l)}</span><span class="v">${esc(v)}</span></button>`;
    }).join('');
  }
  $('#kpiStrip').addEventListener('click',e=>{
    const button=e.target.closest('[data-kpi-label]');
    if(button)toggleKpi(button.dataset.kpiLabel);
  });


  function buildColumns(){document.querySelectorAll('.excel-filter-portal').forEach(p=>p.remove());const hr=$('#taskHeaderRow'),fr=$('#taskFilterRow');hr.innerHTML='';fr.innerHTML='';buildColumnValueCache();for(const [key,label] of COLUMN_DEFS){const th=document.createElement('th');th.dataset.column=key;th.textContent=label;th.title='Click para ordenar';th.style.cursor='pointer';th.onclick=()=>{if(window.__ofsResizeGuard)return;if(state.sort.key===key)state.sort.direction*=-1;else state.sort={key,direction:1};applyFilters();};hr.append(th);const fh=document.createElement('th');fh.dataset.column=key;const host=document.createElement('div');host.className='multi-host';fh.append(host);fr.append(fh);makeExcelColumnFilter(host,key);}buildColumnChooser();applyColumnVisibility();installColumnResizers();}

  function buildColumnChooser(){const p=$('#columnChooserPanel');p.innerHTML=`<div class="column-chooser-actions"><button id="colsAll" class="btn ghost small">Todas</button><button id="colsEss" class="btn ghost small">Esenciales</button><button id="colsClose" class="btn ghost small chooser-close">Cerrar ×</button></div>${COLUMN_DEFS.map(([k,l])=>`<label><input class="col-check" type="checkbox" value="${k}" ${state.hiddenColumns.has(k)?'':'checked'}><span>${esc(l)}</span></label>`).join('')}`;p.querySelectorAll('.col-check').forEach(i=>i.onchange=()=>{i.checked?state.hiddenColumns.delete(i.value):state.hiddenColumns.add(i.value);applyColumnVisibility();savePreferences();});$('#colsAll').onclick=e=>{e.preventDefault();state.hiddenColumns.clear();buildColumnChooser();applyColumnVisibility();savePreferences();};$('#colsEss').onclick=e=>{e.preventDefault();state.hiddenColumns=new Set(COLUMN_DEFS.map(x=>x[0]).filter(k=>!ESSENTIAL_COLUMNS.has(k)));buildColumnChooser();applyColumnVisibility();savePreferences();};$('#colsClose').onclick=e=>{e.preventDefault();$('#columnChooser').open=false;};}
  function applyColumnVisibility(){for(const [k] of COLUMN_DEFS)document.querySelectorAll(`[data-column="${k}"]`).forEach(el=>el.classList.toggle('col-hidden',state.hiddenColumns.has(k)));}

  function createdClass(r){const d=createdDate(r);if(!d)return'';const now=new Date();const today=Date.UTC(now.getFullYear(),now.getMonth(),now.getDate());const day=Date.UTC(d.getFullYear(),d.getMonth(),d.getDate());const age=Math.max(0,Math.floor((today-day)/86400000));return age===0?'created-white':age===1?'created-green':age===2?'created-yellow':'created-old';}

  function duplicateSets(rows){
    const countBy=(getter)=>{const m=new Map();for(const r of rows){const v=upper(getter(r));if(!v||v==='—')continue;m.set(v,(m.get(v)||0)+1);}return new Set([...m].filter(([,n])=>n>1).map(([v])=>v));};
    const countByRows=(subset,getter)=>{const m=new Map();for(const r of subset){const v=upper(getter(r));if(!v||v==='—')continue;m.set(v,(m.get(v)||0)+1);}return new Set([...m].filter(([,n])=>n>1).map(([v])=>v));};
    const openRows=rows.filter(r=>isLiveStatus(r.Estado||r.status));
    return {nodes:countByRows(openRows,node),parents:countByRows(openRows,parentEvent)};
  }

  function renderTable(){const total=state.filtered.length,pages=Math.max(1,Math.ceil(total/PAGE_SIZE));if(state.page>pages)state.page=pages;const start=(state.page-1)*PAGE_SIZE,rows=state.filtered.slice(start,start+PAGE_SIZE),dups=state.duplicateBaseSets||duplicateSets(availableRows());$('#opPageLabel').textContent=`Página ${state.page} de ${pages}`;$('#opCountLabel').textContent=`${total.toLocaleString('es-AR')} visibles · ${state.meta.apiTotal.toLocaleString('es-AR')} intervenciones · ${state.meta.uniqueTotal.toLocaleString('es-AR')} tareas únicas`;$('#opPrev').disabled=state.page<=1;$('#opNext').disabled=state.page>=pages;const tb=$('#opTbody');if(!rows.length){tb.innerHTML=`<tr><td colspan="${COLUMN_DEFS.length}" class="empty">Sin resultados con los filtros actuales</td></tr>`;return;}tb.innerHTML=rows.map(r=>`<tr data-task="${esc(taskId(r))}">${COLUMN_DEFS.map(([k])=>{const duplicate=(k==='node'&&dups.nodes.has(upper(node(r))))||(k==='parentEvent'&&dups.parents.has(upper(parentEvent(r))));return `<td data-column="${k}" class="${k==='ageDays'?`age-cell ${taskAgeClass(r)}`:(k==='eventAgeDays'||k==='parentAgeDays')?`age-cell ${eventAgeClass(k==='parentAgeDays'?parentAgeDays(r):eventAgeDays(r))}`:''} ${k==='created'?`created-cell ${createdClass(r)}`:''} ${k==='tipif'&&['VFF','FMR','VFE'].includes(upper(siglaTarea(r)))?'tipif-alert':''} ${(k==='capa'||k==='capaSubcapa')?`capa-cell ${capaClass(capa(r))}`:''} ${k==='subcapa'?`subcapa-cell ${subcapaClass(subcapa(r))}`:''} ${k==='origin'?`origin-cell ${originClass(origin(r))}`:''} ${duplicate?'duplicate-green':''}">${cellHtml(r,k)}</td>`;}).join('')}</tr>`).join('');applyColumnVisibility();tb.querySelectorAll('tr[data-task]').forEach(tr=>tr.onclick=e=>{const btn=e.target.closest('[data-mira-node]');if(btn){showMiraPopup(btn.dataset.miraNode);return;}if(e.target.closest('.task-link'))openTaskDrawer(tr.dataset.task)});requestAnimationFrame(updateTableHorizontalScroller);scheduleMiraScan();}

  function cellHtml(r,k){if(k.startsWith('mira_')){
    const lowUp=k==='mira_up'&&miraUpRaw(r)!==null&&miraUpRaw(r)<80;
    const val=miraValue(r,k);
    // Umbral estricto: 79,99% es rojo/rosa; 80% exacto no se resalta.
    // Conservar el valor original para evaluar el umbral sin depender de formato local.
    return `<button type="button" class="mira-click${lowUp?' mira-up-low':''}" data-mira-node="${esc(node(r))}" title="Ver estadísticas MIRA5 · activar VPN">${esc(val===''?'—':val)}</button>`;
  }if(k==='task')return`<span class="task-link">${esc(taskId(r))}</span>`;if(k==='status')return badgeStatus(r.Estado||r.status);if(k==='affected')return affected(r)?`<span class="badge ${/^SI$/i.test(affected(r))?'warn':'ok'}">${esc(affected(r))}</span>`:'—';return esc(fmt(rowValueByColumn(r,k)));}

  function taskHistoryFromDate(id,cur){
    const direct=createdDate(cur);
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
  // Campos independientes de OFSC: las notas de cierre no sustituyen las notas de actividad.
  function interventionDetailsHtml(record,{showActivityNotes=false}={}){
    const notes=norm(record.XA_Activity_Notes ?? record.activityNotes ?? '');
    const closure=norm(record.closure_notes ?? record.closureNotes ?? '');
    const reason=norm(record.XA_Complete_Reason ?? record.completeReason ?? '');
    return [
      showActivityNotes && notes ? `<div class="notes"><div class="intervention-field-label">NOTA DE CREACIÓN</div>${esc(notes)}</div>` : '',
      closure ? `<div class="notes"><div class="intervention-field-label">NOTA DE INTERVENCIÓN</div>${esc(closure)}</div>` : '',
      (reason && statusKey(record.Estado||record.estado||record.status)==='completed') ? `<div class="intervention-reason"><strong>Motivo de cierre:</strong> ${esc(reason)}</div>` : ''
    ].join('');
  }
  function renderTaskDrawer(id,cur,hist,{loading=false,error='',sources=''}={}){
    let ordered=historySort(hist||[]);
    const c=historyCounters(ordered);
    const summary=[
      ['Estado actual',statusEs(cur.Estado||cur.status)],['Creado Tableau',createdDisplay(cur)],['Nodo',node(cur)],
      ['Contratista',contractor(cur)],['Técnico',tech(cur)],['Afectación',affected(cur)],['Prioridad',priority(cur)],
      ['Veces suspendida',loading?'…':c.suspended],['Veces iniciada',loading?'…':c.started]
    ];
    const timeline=ordered.map((x,i)=>`<div class="visit"><div class="visit-card"><div class="visit-top">${badgeStatus(x.Estado||x.estado||x.status)}<strong>${i===0?'Última intervención':'Intervención'}</strong></div><div class="visit-times"><b>Fecha:</b> ${esc(formatDate(x.FechaIntervencion||x.FechaEfectiva||x.fecha_intervencion||x.date))} · <b>Start:</b> ${esc(formatDate(startValue(x)))} · <b>End:</b> ${esc(formatDate(endValue(x)))} · <b>Agendado:</b> ${esc(formatDateOnly(scheduled(x)))}</div><div class="visit-meta">${esc(fmt(tech(x)))} · ${esc(fmt(contractor(x)))} · ${esc(fmt(tree(x)))} · ${esc(fmt(node(x)))}</div>${interventionDetailsHtml(x,{showActivityNotes:i===0})}</div></div>`).join('');
    const sourceText=sources?`<div class="history-source">Fuente histórica: ${esc(sources)}</div>`:'';
    const historyBody=loading?'<div class="empty">Consultando OFSC…</div>':error?`<div class="empty">Histórico parcial/no disponible: ${esc(error)}</div>${timeline}`:(timeline||'<div class="empty">No se encontraron intervenciones anteriores para esta tarea.</div>');
    $('#drawerTitle').textContent=id;
    $('#drawerBody').innerHTML=`<h3 class="history-title">Histórico de intervenciones</h3>${sourceText}<div class="timeline">${historyBody}</div>`;
  }
  async function fetchTaskHistoryOfsc(id,cur){
    const url=new URL(`${C.HISTORICO_BASE_URL}/api/ticket`);
    url.searchParams.set('apptNumber',id);
    url.searchParams.set('from',taskHistoryFromDate(id,cur));
    url.searchParams.set('to',todayLocalKey());
    const j=await fetchJson(url.toString(),{cache:'no-store'},60000);
    return Array.isArray(j.items)?j.items:[];
  }

  async function fetchCombinedTaskHistory(id,cur){
    // V22.47: histórico operativo exclusivamente desde OFSC.
    // /api/ticket en el Worker consulta directamente Oracle Field Service.
    // historico_tickets (D1) queda reservado para estadísticas/análisis futuro.
    const cacheKey=upper(id);
    if(state.taskHistoryCache.has(cacheKey))return state.taskHistoryCache.get(cacheKey);

    const promise=(async()=>{
      try{
        const items=await fetchTaskHistoryOfsc(id,cur);
        return {items,sources:'OFSC',error:''};
      }catch(error){
        return {
          items:[],
          sources:'OFSC',
          error:String(error?.message||error)
        };
      }
    })();

    state.taskHistoryCache.set(cacheKey,promise);
    return promise;
  }
  async function openTaskDrawer(id){
    const local=historyForTask(id),cur=state.current.find(r=>taskId(r)===id)||local[0];if(!cur)return;
    $('#drawer').classList.add('open');$('#drawer').setAttribute('aria-hidden','false');applyHistoryZoom();
    renderTaskDrawer(id,cur,[],{loading:true});
    try{
      const result=await fetchCombinedTaskHistory(id,cur);
      const enriched=result.items.find(r=>String(r.activityId||'')===String(cur.activityId||'') && (r.XA_Activity_Notes||r.closure_notes));
      const currentWithNotes=enriched?{...cur,...enriched}:cur;
      renderTaskDrawer(id,currentWithNotes,result.items,{error:result.error,sources:result.sources});
    }catch(e){
      console.error('Histórico OFSC',e);
      renderTaskDrawer(id,cur,[],{error:String(e?.message||e)});
    }
  }
  function closeDrawer(){$('#drawer').classList.remove('open');$('#drawer').setAttribute('aria-hidden','true');}

  function buildMobilesData(){const m=new Map();for(const r of state.filtered){const id=resource(r)||tech(r)||'Sin recurso';if(!m.has(id))m.set(id,{id,name:tech(r)||id,contractor:contractor(r),items:[]});m.get(id).items.push(r);}return [...m.values()].map(g=>{const c=k=>g.items.filter(r=>statusKey(r.Estado||r.status)===k).length;const dates=g.items.map(interventionTimestamp).filter(Boolean);const completed=c('completed');return {...g,tickets:new Set(g.items.map(taskId)).size,completed,suspended:c('suspended'),started:c('started'),assigned:c('assigned'),enroute:c('enroute'),scheduled:c('scheduled'),effectiveness:g.items.length?completed/g.items.length*100:0,first:dates.length?Math.min(...dates):0,last:dates.length?Math.max(...dates):0};}).sort((a,b)=>b.tickets-a.tickets);}
  function renderMobiles(){const q=norm($('#mobileSearch').value).toLowerCase();const rows=buildMobilesData().filter(r=>!q||[r.name,r.id,r.contractor].join(' ').toLowerCase().includes(q));$('#mobilesTbody').innerHTML=rows.length?rows.map(r=>`<tr><td>${esc(r.name)}</td><td>${esc(r.id)}</td><td>${esc(r.contractor)}</td><td class="num">${r.tickets}</td><td class="num">${r.completed}</td><td class="num">${r.suspended}</td><td class="num">${r.started}</td><td class="num">${r.assigned}</td><td class="num">${r.enroute}</td><td class="num">${r.scheduled}</td><td class="num">${r.effectiveness.toFixed(1)}%</td><td>${r.first?esc(formatDate(new Date(r.first).toISOString())):'—'}</td><td>${r.last?esc(formatDate(new Date(r.last).toISOString())):'—'}</td></tr>`).join(''):'<tr><td colspan="13" class="empty">Sin resultados</td></tr>';}
  function buildContractorData(){const m=new Map();for(const r of state.filtered){const name=contractor(r)||'Sin Contratista';if(!m.has(name))m.set(name,{name,items:[],mobiles:new Set()});const g=m.get(name);g.items.push(r);if(resource(r)||tech(r))g.mobiles.add(resource(r)||tech(r));}return [...m.values()].map(g=>{const c=k=>g.items.filter(r=>statusKey(r.Estado||r.status)===k).length;const completed=c('completed');return {...g,tickets:new Set(g.items.map(taskId)).size,completed,suspended:c('suspended'),started:c('started'),assigned:c('assigned'),enroute:c('enroute'),scheduled:c('scheduled'),effectiveness:g.items.length?completed/g.items.length*100:0};}).sort((a,b)=>b.tickets-a.tickets);}
  function renderContractors(){const rows=buildContractorData();$('#contractorsTbody').innerHTML=rows.length?rows.map(r=>`<tr><td>${esc(r.name)}</td><td class="num">${r.mobiles.size}</td><td class="num">${r.tickets}</td><td class="num">${r.completed}</td><td class="num">${r.suspended}</td><td class="num">${r.started}</td><td class="num">${r.assigned}</td><td class="num">${r.enroute}</td><td class="num">${r.scheduled}</td><td class="num">${r.effectiveness.toFixed(1)}%</td></tr>`).join(''):'<tr><td colspan="10" class="empty">Sin resultados</td></tr>';}

  function initMap(){if(state.map)return;state.map=L.map('map').setView(C.DEFAULT_MAP_CENTER||[-34.6037,-58.3816],C.DEFAULT_MAP_ZOOM||10);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(state.map);state.markers=L.featureGroup().addTo(state.map);}
  function updateMap(){if($('#mapModal')?.classList.contains('hidden'))return;initMap();state.markers.clearLayers();for(const r of state.filtered){const lat=Number(r.latitude??r.CoordinateY??r.coordinateY),lng=Number(r.longitude??r.CoordinateX??r.coordinateX);if(!Number.isFinite(lat)||!Number.isFinite(lng))continue;const m=L.marker([lat,lng]).bindPopup(`<strong>${esc(taskId(r))}</strong><br>${esc(node(r))}<br>${esc(tech(r))}<br>${esc(statusEs(r.Estado||r.status))}`);m.on('click',()=>openTaskDrawer(taskId(r)));state.markers.addLayer(m);}const layers=state.markers.getLayers();if(layers.length)state.map.fitBounds(state.markers.getBounds().pad(.08));setTimeout(()=>state.map.invalidateSize(),80);}

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
      const cls=createdClass(r);const fill=cls==='created-white'?'FFFFFF':cls==='created-green'?XL.green:cls==='created-yellow'?XL.yellow:'F4C7AB';
      const color=cls==='created-white'?'17263A':cls==='created-green'?XL.greenText:cls==='created-yellow'?XL.yellowText:'7A3F19';
      cell.s={...base,fill:{fgColor:{rgb:fill}},font:{...base.font,bold:true,color:{rgb:color}}};
    } else if(key==='ageDays'){
      const cls=taskAgeClass(r);const fill=cls==='age-white'?'FFFFFF':cls==='age-green'?XL.green:cls==='age-yellow'?XL.yellow:XL.red;const color=cls==='age-white'?'17263A':cls==='age-green'?XL.greenText:cls==='age-yellow'?XL.yellowText:XL.redText;
      cell.s={...base,fill:{fgColor:{rgb:fill}},font:{...base.font,bold:true,color:{rgb:color}}};
    } else if(key==='eventAgeDays'||key==='parentAgeDays'){
      const a=Number(key==='parentAgeDays'?parentAgeDays(r):eventAgeDays(r));const fill=a>=3?XL.red:a>=2?XL.yellow:XL.green;const color=a>=3?XL.redText:a>=2?XL.yellowText:XL.greenText;
      cell.s={...base,fill:{fgColor:{rgb:fill}},font:{...base.font,bold:true,color:{rgb:color}}};
    } else if(key==='status'){
      const k=statusKey(r.Estado||r.status);const map={started:['FFEB9C','815F00'],suspended:['FFD7DC','A12734'],assigned:['DCE9FF','215CAD'],enroute:['D8EEF7','1C617A'],scheduled:['EADCFF','64409B'],completed:['D8F4E6','00734A'],cancelled:['ECE7FF','6038A8']};
      if(map[k])cell.s={...base,fill:{fgColor:{rgb:map[k][0]}},font:{...base.font,bold:true,color:{rgb:map[k][1]}}};
    } else if(key==='capa'||key==='subcapa'){
      const c=key==='capa'?capaClass(capa(r)):subcapaClass(subcapa(r));const fill={edificio:XL.blue,fibra:XL.fibra,infra:XL.infra,usac:XL.usac,ingress:'EADCFF',leak:'EADCFF'}[c];if(fill)cell.s={...base,fill:{fgColor:{rgb:fill}}};
    } else if(key==='origin'&&originClass(origin(r))==='externo'){
      cell.s={...base,fill:{fgColor:{rgb:XL.infra}}};
    } else if(key==='origin'&&originClass(origin(r))==='preventivo'){
      cell.s={...base,fill:{fgColor:{rgb:XL.green}},font:{...base.font,bold:true,color:{rgb:XL.greenText}}};
    } else if(key==='tipif'&&['VFF','FMR','VFE'].includes(upper(siglaTarea(r)))){
      cell.s={...base,fill:{fgColor:{rgb:XL.red}},font:{...base.font,bold:true,color:{rgb:XL.redText}}};
    } else if(key==='affected'){
      const yes=/^SI$/i.test(affected(r));cell.s={...base,fill:{fgColor:{rgb:yes?XL.yellow:XL.green}},font:{...base.font,bold:true,color:{rgb:yes?XL.yellowText:XL.greenText}}};
    }
  }
  function styleTasksSheet(ws,rows,cols){
    for(let c=0;c<cols.length;c++){
      const addr=XLSX.utils.encode_cell({r:0,c});if(ws[addr])ws[addr].s={fill:{fgColor:{rgb:XL.dark}},font:{name:'Arial',sz:10,bold:true,color:{rgb:XL.white}},alignment:{horizontal:'center',vertical:'center'},border:xlBorder()};
    }
    const dups=duplicateSets(rows);
    rows.forEach((r,ri)=>{
      cols.forEach(([key],ci)=>{
        const cell=ws[XLSX.utils.encode_cell({r:ri+1,c:ci})];
        if(!cell)return;
        styleCellForRow(cell,key,r);
        const dup=(key==='node'&&dups.nodes.has(upper(node(r))))||(key==='parentEvent'&&dups.parents.has(upper(parentEvent(r))));
        if(dup){
          cell.s={...cell.s,fill:{fgColor:{rgb:XL.green}},font:{...(cell.s?.font||{}),bold:true,color:{rgb:XL.greenText}}};
        }
      });
    });
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
      if(cell&&/^Tareas \+3 días$/i.test(label)){cell.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.red}}};if(val)val.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.red}},font:{name:'Arial',sz:10,bold:true,color:{rgb:XL.redText}}};}
      if(cell&&/^Tareas 2 días$/i.test(label)){cell.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.yellow}}};if(val)val.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.yellow}},font:{name:'Arial',sz:10,bold:true,color:{rgb:XL.yellowText}}};}
      if(cell&&/^Tareas 1 día$/i.test(label)){cell.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.green}}};if(val)val.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.green}},font:{name:'Arial',sz:10,bold:true,color:{rgb:XL.greenText}}};}
      if(cell&&/^Fibra$/i.test(label)){cell.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.fibra}}};if(val)val.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.fibra}},font:{name:'Arial',sz:10,bold:true}};}
      if(cell&&/^Red \+ Energía$/i.test(label)){cell.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.usac}}};if(val)val.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.usac}},font:{name:'Arial',sz:10,bold:true}};}
      if(cell&&/^Infra$/i.test(label)){cell.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.infra}}};if(val)val.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.infra}},font:{name:'Arial',sz:10,bold:true}};}
      if(cell&&/^Edificio$/i.test(label)){cell.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.blue}}};if(val)val.s={...xlBaseStyle(),fill:{fgColor:{rgb:XL.blue}},font:{name:'Arial',sz:10,bold:true}};}
    }
    ws['!cols']=[{wch:28},{wch:32},{wch:18}];
  }
  function kpiBoxType(label){
    if(/\+3 días/i.test(label))return 'danger';
    if(/^2 días/i.test(label))return 'warning';
    if(/^1 día/i.test(label))return 'success';
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
    if(type==='success')return {fill:XL.green,text:XL.greenText};
    if(type==='fibra')return {fill:XL.fibra,text:'8A6400'};
    if(type==='usac')return {fill:XL.usac,text:'355E3B'};
    if(type==='edificio')return {fill:XL.blue,text:'1F4E79'};
    return {fill:'FFFFFF',text:'17263A'};
  }
  function captureAffectedClass(r){if(/^SI$/i.test(affected(r)))return 'affected-yes'; if(/^NO$/i.test(affected(r)))return 'affected-no'; return ''; }
  function captureStatusPill(r){const k=statusKey(r.Estado||r.status);return `<span class="status-pill ${k}">${esc(statusEs(r.Estado||r.status))}</span>`;}
  function captureCellHtml(r,key,dups=null){
    if(key==='created'){const cls=createdClass(r);return `<td class="${cls}">${esc(rowValueByColumn(r,'created'))}</td>`;}
    if(key==='affected'){const cls=captureAffectedClass(r);return `<td class="${cls}">${esc(affected(r)||'—')}</td>`;}
    if(key==='priority'){return `<td>${esc(priority(r)||'—')}</td>`;}
    if(key==='status'){return `<td>${captureStatusPill(r)}</td>`;}
    if(key==='ageDays'){const cls=taskAgeClass(r);return `<td class="${cls}">${esc(ageDays(r)??'—')}</td>`;}
    if(key==='eventAgeDays'||key==='parentAgeDays'){const v=key==='parentAgeDays'?parentAgeDays(r):eventAgeDays(r);const cls=eventAgeClass(v);return `<td class="${cls}">${esc(v??'—')}</td>`;}
    if(key==='scheduled'){return `<td>${esc(formatDateOnly(scheduled(r)))}</td>`;}
    if(key==='tipif'){const v=siglaTarea(r);return `<td class="${['VFF','FMR','VFE'].includes(upper(v))?'tipif-alert':''}">${esc(v)}</td>`;}
    if(key==='capa'){return `<td class="capa-cell ${capaClass(capa(r))}">${esc(capa(r)||'—')}</td>`;}
    if(key==='subcapa'){return `<td class="subcapa-cell ${subcapaClass(subcapa(r))}">${esc(subcapa(r)||'—')}</td>`;}
    if(key==='origin'){return `<td class="origin-cell ${originClass(origin(r))}">${esc(origin(r)||'—')}</td>`;}
    const value = key==='task'?taskId(r):key==='node'?node(r):key==='tipif'?siglaTarea(r):key==='subcapa'?subcapa(r):key==='origin'?origin(r):key==='event'?(oracleEvent(r)||parentEvent(r)):key==='parentEvent'?parentEvent(r):key==='contractor'?contractor(r):rowValueByColumn(r,key);
    const duplicate=dups&&((key==='node'&&dups.nodes.has(upper(node(r))))||(key==='parentEvent'&&dups.parents.has(upper(parentEvent(r)))));
    return `<td class="${duplicate?'duplicate-green':''}">${esc(value)}</td>`;
  }

  function createdTimestamp(r){
    const d=createdDate(r);
    return d?d.getTime():0;
  }

  function capturePriorityGroups(rows){
    const red=[],yellow=[],normal=[];
    for(const r of rows){
      const h=ageDays(r);
      if(Number.isFinite(h)&&h>=3)red.push(r);
      else if(Number.isFinite(h)&&h>=2)yellow.push(r);
      else normal.push(r);
    }
    const byAgeThenCreated=(a,b)=>{
      const ad=ageDays(a),bd=ageDays(b);
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

  function contractorCaptureCardHtml(contractorName,allRows,previewRows,cols,pageIndex=0,pageCount=1){
    const captureDups=duplicateSets(allRows);
    const kpis=computeKpisForRows(allRows);
    const top=kpis.slice(0,8), bottom=kpis.slice(8,15);
    const now=new Date();
    const pageText=pageCount>1?` · captura ${pageIndex+1}/${pageCount}`:'';
    return `<div class="export-capture-card excel-like"><div class="export-capture-title">Consulta ETA · ${esc(contractorName)}</div><div class="export-capture-sub">Resumen operativo · ${esc(currentRange().from)} → ${esc(currentRange().to)} · generado ${esc(now.toLocaleString('es-AR'))}${pageText}</div><div class="excel-kpi-grid">${top.map(([l,v])=>`<div class="excel-kpi ${kpiCaptureClass(l)}"><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`).join('')}</div><div class="excel-kpi-grid second">${bottom.map(([l,v])=>`<div class="excel-kpi ${kpiCaptureClass(l)}"><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`).join('')}</div><table class="export-capture-preview"><thead><tr>${cols.map(([,label])=>`<th>${esc(label)}</th>`).join('')}</tr></thead><tbody>${previewRows.map(r=>`<tr>${cols.map(([key])=>captureCellHtml(r,key,captureDups)).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function buildTaskSheetData(rows,cols){
    const kpis=computeKpisForRows(rows);
    const top=kpis.slice(0,8), bottom=kpis.slice(8,15);
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
    for(let r=0;r<4;r++) for(let c=0;c<Math.min(8,cols.length);c++){const addr=XLSX.utils.encode_cell({r,c});if(ws[addr]){const label=(r<2?computed.slice(0,8):computed.slice(8,15))[c]?.[0]||'';const pal=kpiPalette(label);ws[addr].s={font:{name:'Arial',sz:r%2===0?9:13,bold:true,color:{rgb:pal.text}},alignment:{horizontal:'center',vertical:'center',wrapText:true},fill:{fgColor:{rgb:pal.fill}},border:xlBorder()};}}
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
    if(/\+3 días/i.test(label))return'age-red';
    if(/^2 días/i.test(label))return'age-yellow';
    if(/^1 día/i.test(label))return'age-green';
    if(/^Caídas /i.test(label))return'kpi-danger';
    if(/^Fibra$/i.test(label))return'capa-fibra';
    if(/^Red \+ Energía$/i.test(label))return'capa-usac';
    if(/^Infra$/i.test(label))return'capa-infra';
    if(/^Edificio$/i.test(label))return'capa-edificio';
    return'';
  }
  async function makeContractorDashboardImages(contractorName,rows,cols){
    if(typeof html2canvas==='undefined')return [];
    const pages=buildCapturePages(rows,18);
    const images=[];
    for(let i=0;i<pages.length;i++){
      const host=document.createElement('div');host.className='export-capture-host';
      host.innerHTML=contractorCaptureCardHtml(contractorName,rows,pages[i],cols,i,pages.length);
      document.body.appendChild(host);
      try{
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const canvas=await html2canvas(host,{backgroundColor:'#f4f7fb',scale:1.35,useCORS:true,logging:false});

        // Generamos un PNG binario real. Evita depender de dataURL/base64 y
        // produce entradas ZIP más estándar para el Explorador de Windows.
        const pngBlob=await new Promise((resolve,reject)=>{
          canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('No se pudo generar la captura PNG')),'image/png');
        });
        images.push(pngBlob);
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
      const cls=createdClass(r),fill=cls==='created-white'?'FFFFFF':cls==='created-green'?'C6EFCE':cls==='created-yellow'?'FFEB9C':'F4C7AB';const color=cls==='created-white'?'17263A':cls==='created-green'?'007D51':cls==='created-yellow'?'8A6400':'7A3F19';cell.fill=excelJsFill(fill);cell.font={name:'Arial',size:10,bold:true,color:{argb:excelJsArgb(color)}};
    } else if(key==='ageDays'){
      const cls=taskAgeClass(r),fill=cls==='age-white'?'FFFFFF':cls==='age-green'?'C6EFCE':cls==='age-yellow'?'FFEB9C':'FFC7CE',color=cls==='age-white'?'17263A':cls==='age-green'?'007D51':cls==='age-yellow'?'8A6400':'9C0006';cell.fill=excelJsFill(fill);cell.font={name:'Arial',size:10,bold:true,color:{argb:excelJsArgb(color)}};
    } else if(key==='eventAgeDays'||key==='parentAgeDays'){
      const a=Number(key==='parentAgeDays'?parentAgeDays(r):eventAgeDays(r)),fill=a>=3?'FFC7CE':a>=2?'FFEB9C':'C6EFCE',color=a>=3?'9C0006':a>=2?'8A6400':'007D51';cell.fill=excelJsFill(fill);cell.font={name:'Arial',size:10,bold:true,color:{argb:excelJsArgb(color)}};
    } else if(key==='status'){
      const map={started:['FFEB9C','815F00'],suspended:['FFD7DC','A12734'],assigned:['DCE9FF','215CAD'],enroute:['D8EEF7','1C617A'],scheduled:['EADCFF','64409B'],completed:['D8F4E6','00734A'],cancelled:['ECE7FF','6038A8']};const m=map[statusKey(r.Estado||r.status)];if(m){cell.fill=excelJsFill(m[0]);cell.font={name:'Arial',size:10,bold:true,color:{argb:excelJsArgb(m[1])}};}
    } else if(key==='capa'||key==='subcapa'){
      const c=key==='capa'?capaClass(capa(r)):subcapaClass(subcapa(r)),fill={edificio:'D9EAFA',fibra:'FFE69A',infra:'FFC2CA',usac:'D8EFD0',ingress:'EADCFF',leak:'EADCFF'}[c];if(fill)cell.fill=excelJsFill(fill);
    } else if(key==='origin'&&originClass(origin(r))==='externo'){
      cell.fill=excelJsFill('FFC2CA');cell.font={name:'Arial',size:10,color:{argb:'FF9C0006'}};
    } else if(key==='origin'&&originClass(origin(r))==='preventivo'){
      cell.fill=excelJsFill('C6EFCE');cell.font={name:'Arial',size:10,bold:true,color:{argb:excelJsArgb('007D51')}};
    } else if(key==='tipif'&&['VFF','FMR','VFE'].includes(upper(siglaTarea(r)))){
      cell.fill=excelJsFill('FFC7CE');cell.font={name:'Arial',size:10,bold:true,color:{argb:excelJsArgb('9C0006')}};
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
    const workbookDups=duplicateSets(rows);
    rows.forEach(r=>{const row=ws.addRow(Object.fromEntries(cols.map(([k])=>[k,rowValueByColumn(r,k)])));cols.forEach(([k],i)=>{const cell=row.getCell(i+1);excelJsApplyTaskCellStyle(cell,k,r);const dup=(k==='node'&&workbookDups.nodes.has(upper(node(r))))||(k==='parentEvent'&&workbookDups.parents.has(upper(parentEvent(r))));if(dup){cell.fill=excelJsFill('C6EFCE');cell.font={name:'Arial',size:10,bold:true,color:{argb:excelJsArgb('007D51')}};}});});
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
  function dailyStateRowsForExport(status,dayKey){
    const map=new Map();
    for(const r of movementRowsForDailyState()){
      const d=movementDate(r);if(!d||localDayKey(d)!==dayKey)continue;
      if(statusKey(r.Estado||r.estado||r.status)!==status)continue;
      const id=taskId(r)||`${resource(r)}|${d.getTime()}|${status}`;
      const prev=map.get(id);
      if(!prev||movementDate(prev)?.getTime()<=d.getTime())map.set(id,r);
    }
    return [...map.values()].sort((a,b)=>(movementDate(b)?.getTime()||0)-(movementDate(a)?.getTime()||0));
  }
  function dailyStateLabel(status){return ({completed:'Completados',suspended:'Suspendidos',cancelled:'Cancelados',notdone:'No_realizados'})[status]||status;}
  function exportDailyStateTickets(status,dayKey){
    if(typeof XLSX==='undefined'){showToast('No se pudo cargar la librería Excel.');return;}
    const rows=dailyStateRowsForExport(status,dayKey);
    if(!rows.length){showToast('No hay tickets para exportar en esa celda.');return;}
    const cols=visibleColumnDefs();
    if(!cols.length){showToast('No hay columnas visibles para exportar.');return;}
    const wb=buildStyledTasksWorkbook(rows,cols);
    const safeDay=String(dayKey||'').replace(/[^0-9-]/g,'');
    XLSX.writeFile(wb,`ETA_${dailyStateLabel(status)}_${safeDay}.xlsx`,{cellStyles:true});
    showToast(`Excel generado: ${rows.length} ticket(s)`);
  }
  function dailyAllRowsForExport(dayKey){
    const allowed=new Set(['completed','suspended','cancelled','notdone']),map=new Map();
    for(const r of movementRowsForDailyState()){
      const d=movementDate(r);if(!d||localDayKey(d)!==dayKey)continue;
      const sk=statusKey(r.Estado||r.estado||r.status);if(!allowed.has(sk))continue;
      const id=taskId(r)||`${resource(r)}|${d.getTime()}|${sk}`;const prev=map.get(id);
      if(!prev||(movementDate(prev)?.getTime()||0)<=d.getTime())map.set(id,r);
    }
    return [...map.values()].sort((a,b)=>(movementDate(b)?.getTime()||0)-(movementDate(a)?.getTime()||0));
  }
  function exportDailyAllTickets(dayKey){
    if(typeof XLSX==='undefined'){showToast('No se pudo cargar la librería Excel.');return;}
    const rows=dailyAllRowsForExport(dayKey);if(!rows.length){showToast('No hay tickets para exportar en ese día.');return;}
    const cols=visibleColumnDefs();if(!cols.length){showToast('No hay columnas visibles para exportar.');return;}
    const wb=buildStyledTasksWorkbook(rows,cols);const safeDay=String(dayKey||'').replace(/[^0-9-]/g,'');
    XLSX.writeFile(wb,`ETA_Todos_estados_${safeDay}.xlsx`,{cellStyles:true});showToast(`Excel generado: ${rows.length} ticket(s)`);
  }

  function computeKpisForRows(rows){
    const count=p=>rows.filter(p).length,unique=p=>new Set(rows.filter(p).map(taskId)).size;
    const eventDays=r=>eventAgeDays(r);
    const days=rows.map(ageDays).filter(Number.isFinite);
    const oldestDays=days.length?Math.max(...days):0;
    const layer=r=>capa(r).toLowerCase();
    return [
      ['Abiertos',count(r=>isLiveStatus(r.Estado||r.status)),''],
      ['+3 días',count(r=>(ageDays(r)??-1)>=3),''],
      ['2 días',count(r=>ageDays(r)===2),''],
      ['1 día',count(r=>ageDays(r)===1),''],
      ['Más antigua',`${oldestDays} días`,''],
      ['Caídas nodo',unique(r=>['VFF','FMR'].includes(siglaTarea(r))),''],
      ['Caídas Edif',unique(r=>siglaTarea(r)==='VFE'),''],
      ['Ingress',unique(r=>['EDF','LDI','LIH','LII','EDI'].includes(siglaTarea(r))),''],
      ['Fibra',unique(r=>layer(r).includes('fibra')),''],
      ['Red + Energía',unique(r=>layer(r).includes('usac')),''],
      ['Infra',unique(r=>layer(r)==='infra'),''],
      ['Edificio',unique(r=>layer(r)==='edificio'),''],
      ['Ev +2d',count(r=>(eventDays(r)??-1)>=2),''],
      ['Ev +3d',count(r=>(eventDays(r)??-1)>=3),''],
      ['Ev +7d',count(r=>(eventDays(r)??-1)>=7),'']
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
    return String(value||'Sin_Contratista')
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .trim()
      .replace(/[\/:*?"<>|]/g,'_')
      .replace(/\s+/g,'_')
      .replace(/[^A-Za-z0-9._-]/g,'_')
      .replace(/_+/g,'_')
      .slice(0,80)||'Sin_Contratista';
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
          images=await makeContractorDashboardImages(c,rows,cols);
          images.forEach((pngBlob,idx)=>{
            const suffix=images.length>1?`_${String(idx+1).padStart(2,'0')}`:'';
            zip.file(`${safeFilePart(c)}_${stamp}${suffix}.png`,pngBlob,{
              binary:true,
              compression:'DEFLATE',
              compressionOptions:{level:6}
            });
          });
        }
        // Misma estructura y motor que el botón Excel: Tareas + Resumen KPI,
        // mismas columnas visibles, mismo orden y mismos estilos.
        const wb=buildContractorWorkbook(c,rows,cols);
        bytes=XLSX.write(wb,{bookType:'xlsx',type:'array',cellStyles:true});
        zip.file(`${safeFilePart(c)}_${stamp}.xlsx`,bytes);
        if(i%3===0)await new Promise(resolve=>setTimeout(resolve,0));
      }

      if(btn)btn.textContent='Comprimiendo…';

      // Generación explícita como bytes ZIP + MIME estándar.
      // platform:'DOS' evita atributos UNIX innecesarios en archivos destinados a Windows.
      const zipBytes=await zip.generateAsync({
        type:'uint8array',
        platform:'DOS',
        compression:'DEFLATE',
        compressionOptions:{level:6}
      });
      const blob=new Blob([zipBytes],{type:'application/zip'});
      const objectUrl=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=objectUrl;
      a.download=`Export_Contratistas_${stamp}.zip`;
      a.rel='noopener';
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(objectUrl),5000);
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


  function updateTableHorizontalScroller(){
    const scroller=$('.table-scroll'),bar=$('#tableHScroll'),inner=$('#tableHScrollInner');
    if(!scroller||!bar||!inner)return;
    inner.style.width=`${Math.max(scroller.clientWidth,scroller.scrollWidth)}px`;
    if(Math.abs(bar.scrollLeft-scroller.scrollLeft)>1)bar.scrollLeft=scroller.scrollLeft;
  }
  function installTableHorizontalScroller(){
    const scroller=$('.table-scroll'),bar=$('#tableHScroll');
    if(!scroller||!bar||bar.dataset.bound==='1')return;
    bar.dataset.bound='1';
    let syncing=false;
    bar.addEventListener('scroll',()=>{if(syncing)return;syncing=true;scroller.scrollLeft=bar.scrollLeft;requestAnimationFrame(()=>syncing=false);});
    scroller.addEventListener('scroll',()=>{if(syncing)return;syncing=true;bar.scrollLeft=scroller.scrollLeft;requestAnimationFrame(()=>syncing=false);});
    window.addEventListener('resize',updateTableHorizontalScroller);
    if('ResizeObserver' in window){const ro=new ResizeObserver(updateTableHorizontalScroller);ro.observe(scroller);ro.observe($('#opTable'));state._tableResizeObserver=ro;}
    requestAnimationFrame(updateTableHorizontalScroller);
  }

  // V22.52: ancho por columna persistente y arrastre de borde estilo Excel.
  const BASE_COLUMN_WIDTHS = {"task": 112, "created": 132, "affected": 70, "priority": 58, "node": 74, "tipif": 54, "status": 88, "subcapa": 78, "origin": 70, "event": 92, "parentEvent": 92, "ageDays": 78, "eventAgeDays": 105, "parentAgeDays": 126, "contractor": 108, "scheduled": 84, "tipificacion": 155, "capa": 78, "eventSigla": 72, "endTime": 108, "tech": 128, "resource": 92, "tree": 80, "mira_total": 70, "mira_up": 70};
  const manualColumnWidths = (()=>{try{return JSON.parse(localStorage.getItem('ofsc_column_widths_v2252')||'{}')||{}}catch{return {}}})();
  function columnWidthFor(key){
    const base=Number(manualColumnWidths[key]||BASE_COLUMN_WIDTHS[key]||95);
    return Math.max(44,Math.round(base*(Number(state.tableZoom)||90)/90));
  }
  function applyTableColumnWidths(){
    let sheet=document.getElementById('ofscDynamicWidths');
    if(!sheet){sheet=document.createElement('style');sheet.id='ofscDynamicWidths';document.head.appendChild(sheet);}
    sheet.textContent=COLUMN_DEFS.map(([key])=>{
      const w=columnWidthFor(key);
      return '#opTable [data-column="'+key+'"]{width:'+w+'px!important;min-width:'+w+'px!important;max-width:'+w+'px!important}';
    }).join('\n');
    requestAnimationFrame(updateTableHorizontalScroller);
  }
  function installColumnResizers(){
    const hr=document.querySelector('#taskHeaderRow');if(!hr)return;
    hr.querySelectorAll('th[data-column]').forEach(th=>{
      if(th.querySelector('.col-resize-handle'))return;
      const handle=document.createElement('span');handle.className='col-resize-handle';
      handle.title='Arrastrá para ajustar el ancho de esta columna';
      handle.addEventListener('pointerdown',e=>{
        if(e.button!==0)return;
        e.preventDefault();e.stopPropagation();
        const key=th.dataset.column, x=e.clientX, first=columnWidthFor(key), scale=(Number(state.tableZoom)||90)/90;
        let dragged=false;
        const move=ev=>{dragged=true;manualColumnWidths[key]=Math.max(44,Math.round((first+ev.clientX-x)/scale));applyTableColumnWidths();};
        const stop=()=>{
          window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);
          window.removeEventListener('pointercancel',stop);
          if(dragged){localStorage.setItem('ofsc_column_widths_v2252',JSON.stringify(manualColumnWidths));}
          setTimeout(()=>{window.__ofsResizeGuard=false},50);
        };
        window.__ofsResizeGuard=true;
        window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop,{once:true});window.addEventListener('pointercancel',stop,{once:true});
      });
      th.appendChild(handle);
    });
    applyTableColumnWidths();
  }
  function applyTableZoom(){
    const card=$('#subview-tasks'),label=$('#tableZoomLabel');
    if(!card)return;
    const z=Math.max(80,Math.min(160,Number(state.tableZoom)||90));
    state.tableZoom=z;
    card.classList.remove(...[80,90,100,110,120,130,140,150,160].map(x=>`table-density-${x}`));
    card.classList.add(`table-density-${z}`);
    if(label)label.textContent=`${z}%`;
    applyTableColumnWidths();
    requestAnimationFrame(updateTableHorizontalScroller);
  }
  function changeTableZoom(delta){
    const levels=[80,90,100,110,120,130,140,150,160];
    let idx=levels.indexOf(state.tableZoom);if(idx<0)idx=1;
    idx=Math.max(0,Math.min(levels.length-1,idx+delta));
    state.tableZoom=levels[idx];applyTableZoom();savePreferences();
  }


  function applyHistoryZoom(){
    const panel=document.querySelector('#drawer .drawer-panel'),label=$('#historyZoomLabel');
    if(!panel)return;
    const levels=[85,100,115,130];
    const z=levels.includes(Number(state.historyZoom))?Number(state.historyZoom):100;
    state.historyZoom=z;
    panel.classList.remove(...levels.map(v=>`history-zoom-${v}`));
    panel.classList.add(`history-zoom-${z}`);
    if(label)label.textContent=`${z}%`;
  }
  function changeHistoryZoom(delta){
    const levels=[85,100,115,130];
    let idx=levels.indexOf(Number(state.historyZoom));if(idx<0)idx=1;
    idx=Math.max(0,Math.min(levels.length-1,idx+delta));
    state.historyZoom=levels[idx];applyHistoryZoom();savePreferences();
  }
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
  document.addEventListener('click',e=>{
    if(!e.target.closest('.multi')&&!e.target.closest('.excel-panel'))document.querySelectorAll('.multi-panel').forEach(p=>p.classList.add('hidden'));
    if(!e.target.closest('#etaIngresoDetails')&&!e.target.closest('#dailyStateDetails')&&!e.target.closest('#columnChooser')){
      for(const id of ['etaIngresoDetails','dailyStateDetails','columnChooser'])document.getElementById(id).open=false;
    }
  });
  function flashButton(btn){if(!btn)return;btn.classList.add('pressed');setTimeout(()=>btn.classList.remove('pressed'),180);}
  $('#btnRefresh').onclick=e=>{flashButton(e.currentTarget);loadAllOperativo(true);};
  function setIngresoEtaView(which){
    const day=dailyDateKey(which);
    if(state.ingresoDayKey===day){
      resetFilters();
      document.getElementById('etaIngresoDetails').open=true;
      showToast('Filtros restablecidos · operativo habitual.');
      return;
    }
    state.dailyCompletedDayKey=null;
    state.ingresoDayKey=day;state.ingresoLabel=which;
    closeAllFloatingMenus(document.getElementById('etaIngresoDetails'));applyFilters();
    showToast(`Ingreso ETA ${which}: sin canceladas. Volvé a pulsar ${which} para restablecer filtros.`);
  }
  function setCompletedDayView(which){
    const day=dailyDateKey(which);
    if(state.dailyCompletedDayKey===day){
      resetFilters();
      document.getElementById('dailyStateDetails').open=true;
      showToast('Filtros restablecidos · operativo habitual.');
      return;
    }
    state.ingresoDayKey=null;state.ingresoLabel=null;
    state.dailyCompletedDayKey=day;
    closeAllFloatingMenus(document.getElementById('dailyStateDetails'));applyFilters();
    showToast(`Completados ${which}: volvé a pulsar ${which} para restablecer filtros.`);
  }
  function exportIngresoDay(){
    const day=state.ingresoDayKey||dailyDateKey('hoy');
    const rows=ingresoRowsForDay(day);
    if(!rows.length){showToast('No hay ingresos para exportar.');return;}
    if(typeof XLSX==='undefined'){showToast('No se pudo cargar la librería Excel.');return;}
    const wb=buildStyledTasksWorkbook(rows,visibleColumnDefs());
    XLSX.writeFile(wb,`ETA_Ingreso_${day}.xlsx`,{cellStyles:true});
  }
  // Gráfico de tipificaciones (Ingreso / Completados), construido con los mismos
  // conjuntos únicos que usan los contadores y los Excel. Sin llamadas adicionales.
  function etaChartRows(kind,day){
    const key=dailyDateKey(day);
    return kind==='completados'?completedRowsForDay(key):ingresoRowsForDay(key);
  }
  // Mantener las caídas como dos categorías fijas según la misma regla de los KPI:
  // edificio: VFE; red: VFF y FMR. Los 7 restantes se eligen por frecuencia.
  function etaChartBuckets(rows){
    const counts=new Map();
    for(const r of rows){
      const label=upper(siglaTarea(r))||'SIN SIGLA';
      counts.set(label,(counts.get(label)||0)+1);
    }
    const fixedGroups=[
      {label:'VFE',members:['VFE'],barClass:'eta-chart-bar-fall',itemClass:'eta-chart-item-fall',detailLabel:'Detalle de caídas'},
      {label:'VFF / FMR',members:['VFF','FMR'],barClass:'eta-chart-bar-fall',itemClass:'eta-chart-item-fall',detailLabel:'Detalle de caídas'},
      {label:'LII / LIH / LDI',members:['LII','LIH','LDI'],barClass:'eta-chart-bar-lii',itemClass:'eta-chart-item-lii',detailLabel:'Siglas agrupadas'},
      {label:'RIP / RCP / ACP',members:['RIP','RCP','ACP'],barClass:'eta-chart-bar-rip',itemClass:'eta-chart-item-rip',detailLabel:'Siglas agrupadas'},
      {label:'EDF / EDI / SRE',members:['EDF','EDI','SRE'],barClass:'eta-chart-bar-edf',itemClass:'eta-chart-item-edf',detailLabel:'Siglas agrupadas'},
      {label:'VXC / VXA',members:['VXC','VXA'],barClass:'eta-chart-bar-vx',itemClass:'eta-chart-item-vx',detailLabel:'Siglas agrupadas'},
      {label:'VAO',members:['VAO'],barClass:'eta-chart-bar-vao',itemClass:'eta-chart-item-vao',detailLabel:'Siglas agrupadas'}
    ];
    const used=new Set();
    const fixed=[];
    for(const group of fixedGroups){
      const detail=group.members.map(name=>[name,counts.get(name)||0]).filter(([,n])=>n>0);
      const count=detail.reduce((sum,[,n])=>sum+n,0);
      group.members.forEach(name=>used.add(name));
      if(!count)continue;
      fixed.push({label:group.label,count,detail,barClass:group.barClass,itemClass:group.itemClass,detailLabel:group.detailLabel});
    }
    const rest=[...counts].filter(([name,count])=>!used.has(name)&&count>0)
      .sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'es',{sensitivity:'base'}));
    const remainingSlots=Math.max(0,9-fixed.length);
    const leaders=rest.slice(0,remainingSlots).map(([label,count])=>({label,count,detail:[[label,count]],detailLabel:'Sigla'}));
    const others=rest.slice(remainingSlots);
    const result=[...fixed,...leaders];
    if(others.length)result.push({label:'OTROS',count:others.reduce((sum,[,n])=>sum+n,0),detail:others,itemClass:'eta-chart-item-other',barClass:'eta-chart-bar-other',detailLabel:'Siglas agrupadas'});
    return result;
  }
  function etaChartClose(){
    const modal=$('#etaTipifChartModal');
    if(!modal||modal.classList.contains('hidden'))return;
    modal.classList.add('hidden');modal.setAttribute('aria-hidden','true');
    document.body.classList.remove('eta-chart-open');
    $('#etaChartTooltip').classList.add('hidden');
    (etaChartClose.previousFocus||$('#etaIngresoSummary'))?.focus?.();
  }
  function etaChartOpen(kind,day,sourceButton){
    const modal=$('#etaTipifChartModal'),rows=etaChartRows(kind,day),buckets=etaChartBuckets(rows);
    etaChartClose.previousFocus=sourceButton||document.activeElement;
    closeAllFloatingMenus();
    const dayLabel=day==='ayer'?'Ayer':'Hoy';
    $('#etaChartTitle').textContent=`${kind==='ingreso'?'Ingreso ETA':'Completados'} · ${dayLabel}`;
    $('#etaChartSubtitle').textContent=`${dailyDateKey(day).split('-').reverse().join('/')} · ${rows.length} tickets · ${new Set(rows.map(r=>upper(siglaTarea(r))||'SIN SIGLA')).size} tipificaciones`;
    const body=$('#etaChartBody');
    if(!buckets.length){body.innerHTML='<p class="eta-chart-empty">No hay tickets para graficar en este día.</p>';}
    else{
      const max=Math.max(1,...buckets.map(b=>b.count));
      body.innerHTML=`<div class="eta-chart-plot" aria-label="Cantidad de tickets por tipificación">${buckets.map((b,i)=>{
        const height=Math.max(4,Math.round(b.count/max*100));
        const text=b.label.length>19?b.label.slice(0,17)+'…':b.label;
        const itemClass=['eta-chart-bar-item',b.itemClass||''].filter(Boolean).join(' ');
        const barClass=['eta-chart-bar',b.barClass||''].filter(Boolean).join(' ');
        return `<button type="button" class="${itemClass}" data-eta-bar="${i}" style="--eta-bar-height:${height}%" aria-label="${esc(b.label)}: ${b.count} tickets" title="${esc(b.label)} · ${b.count} tickets"><span class="eta-chart-bar-track"><span class="eta-chart-value">${b.count}</span><span class="${barClass}" style="height:${height}%"></span></span><span class="eta-chart-category" title="${esc(b.label)}">${esc(text)}</span></button>`;
      }).join('')}</div>`;
      body.querySelectorAll('[data-eta-bar]').forEach(btn=>btn.onclick=()=>{
        body.querySelectorAll('.eta-chart-bar-item').forEach(x=>x.classList.remove('selected'));
        btn.classList.add('selected');
        const b=buckets[Number(btn.dataset.etaBar)];
        const tip=$('#etaChartTooltip');
        tip.innerHTML=`<strong>${esc(b.label)}</strong><span>${b.count} ${b.count===1?'ticket':'tickets'}</span>`+
          (b.detail?`<small>${esc((b.detailLabel||'Siglas agrupadas')+': '+b.detail.length)}</small><div class="eta-chart-other-list">${[...b.detail].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'es',{sensitivity:'base'})).map(([label,n])=>`<div><span>${esc(label)}</span><b>${n}</b></div>`).join('')}</div>`:'');
        tip.classList.remove('hidden');
      });
    }
    $('#etaChartTooltip').classList.add('hidden');
    modal.classList.remove('hidden');modal.setAttribute('aria-hidden','false');
    document.body.classList.add('eta-chart-open');
    $('#etaChartClose').focus();
  }
  document.querySelectorAll('.eta-chart-trigger').forEach(btn=>btn.addEventListener('click',e=>{
    e.preventDefault();e.stopPropagation();etaChartOpen(btn.dataset.chartKind,btn.dataset.chartDay,btn);
  }));
  $('#etaChartClose').addEventListener('click',etaChartClose);
  $('#etaTipifChartModal').addEventListener('click',e=>{if(e.target===$('#etaTipifChartModal'))etaChartClose();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#etaTipifChartModal').classList.contains('hidden')){e.preventDefault();e.stopImmediatePropagation();etaChartClose();}},true);
  $('#btnEtaIngresoAyer').onclick=e=>{e.preventDefault();setIngresoEtaView('ayer');};
  $('#btnEtaIngresoHoy').onclick=e=>{e.preventDefault();setIngresoEtaView('hoy');};
  $('#btnCompletedYesterday').onclick=e=>{e.preventDefault();setCompletedDayView('ayer');};
  $('#btnCompletedToday').onclick=e=>{e.preventDefault();setCompletedDayView('hoy');};
  $('#btnEtaIngresoExcel').onclick=e=>{e.preventDefault();e.stopPropagation();exportIngresoDay();};
  $('#btnCompletedExcel').onclick=e=>{e.preventDefault();e.stopPropagation();exportDailyStateTickets('completed',state.dailyCompletedDayKey||dailyDateKey('hoy'));};
  for(const id of ['etaIngresoDetails','dailyStateDetails','columnChooser']){
    document.getElementById(id)?.addEventListener('toggle',e=>{
      if(e.target.open)closeAllFloatingMenus(e.target);
    });
  }
  $('#btnClearFilters').onclick=e=>{flashButton(e.currentTarget);resetFilters();showToast('Filtros restablecidos');};
  function openMapModal(){const modal=$('#mapModal');if(!modal)return;modal.classList.remove('hidden');modal.setAttribute('aria-hidden','false');$('#btnToggleMap')?.setAttribute('aria-pressed','true');updateMap();}
  function closeMapModal(){const modal=$('#mapModal');if(!modal)return;modal.classList.add('hidden');modal.setAttribute('aria-hidden','true');$('#btnToggleMap')?.setAttribute('aria-pressed','false');}
  $('#btnToggleMap').onclick=e=>{flashButton(e.currentTarget);openMapModal();};
  $('#btnMapClose').onclick=closeMapModal;
  $('#mapModal').addEventListener('click',e=>{if(e.target===$('#mapModal'))closeMapModal();});
  function scrollTaskTableToTop(){const scroller=document.querySelector('.table-scroll');if(scroller)scroller.scrollTo({top:0,behavior:'smooth'});const card=document.querySelector('#subview-tasks');if(card)card.scrollIntoView({block:'start',behavior:'smooth'});}
  $('#opPrev').onclick=()=>{if(state.page>1){state.page--;renderTable();scrollTaskTableToTop();}};$('#opNext').onclick=()=>{const pages=Math.ceil(state.filtered.length/PAGE_SIZE);if(state.page<pages){state.page++;renderTable();scrollTaskTableToTop();}};
  $('#opSearch').oninput=()=>{clearTimeout(state._q);state._q=setTimeout(applyFilters,160);};
  $('#btnExportTasks').onclick=exportTasks;$('#btnExportExcel').onclick=exportExcelByContractor;
  $('#btnTableZoomOut').onclick=()=>changeTableZoom(-1);$('#btnTableZoomIn').onclick=()=>changeTableZoom(1);
  $('#btnHistoryZoomOut').onclick=()=>changeHistoryZoom(-1);$('#btnHistoryZoomIn').onclick=()=>changeHistoryZoom(1);
  $('#btnMenu').onclick=()=>sideMenuOpen(true);$('#btnMenuClose').onclick=()=>sideMenuOpen(false);$('#sideBackdrop').onclick=()=>sideMenuOpen(false);
  $('#btnControl').onclick=()=>loadControlStatus(true);$('#btnControlClose').onclick=()=>$('#controlModal').classList.add('hidden');
  $$('#controlModal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.add('hidden');}));
  $$('[data-close-drawer]').forEach(x=>x.onclick=closeDrawer);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeDrawer();sideMenuOpen(false);closeMapModal();$('#controlModal')?.classList.add('hidden');document.querySelectorAll('.multi-panel').forEach(p=>p.classList.add('hidden'));document.querySelectorAll('.column-chooser').forEach(d=>d.open=false);}});


  // MIRA5 - consultas independientes: nunca bloquean carga OFS
  const miraKeys = MIRA_FIELDS.map(x=>x[0]);
  const miraSettingsKey = 'ofsc_mira_popup_v2251';
  try{const stored=JSON.parse(localStorage.getItem(miraSettingsKey)||'null');mira.selected=new Set((Array.isArray(stored)?stored:['mira_total','mira_up','mira_ofdma','mira_tecnologia']).filter(k=>miraKeys.includes(k)));}catch{mira.selected=new Set(['mira_total','mira_up']);}
  const mPath=(r,path)=>path.split('.').reduce((x,k)=>x?.[k],r);
  const mNodes=()=>[...new Set(state.filtered.slice((state.page-1)*PAGE_SIZE,state.page*PAGE_SIZE).map(node).map(upper).filter(Boolean))];
  function mMatch(n,r){return upper(r.nodo||r.nodoCmts).startsWith(n)||upper(r.nodoCmts).startsWith(n);}
  // Evaluar el umbral con el porcentaje original, antes de redondear el valor visible.
  function miraUpRaw(r){
    const n=upper(node(r));if(!n)return null;
    const arr=miraLookup(n,'statsNodosCmts');
    const nums=arr.map(x=>({v:Number(x.cmStatus?.cmUpPercent),w:Number(x.cmStatus?.cmTot)||0,raw:x.cmStatus?.cmUpPercent})).filter(x=>x.raw!==null&&x.raw!==undefined&&x.raw!==''&&Number.isFinite(x.v));
    if(!nums.length)return null;
    const weights=nums.reduce((a,x)=>a+x.w,0);
    return weights>0?nums.reduce((a,x)=>a+x.v*x.w,0)/weights:nums.reduce((a,x)=>a+x.v,0)/nums.length;
  }
  function miraValue(r,k){
    const n=upper(node(r));if(!n)return'';
    const arr=miraLookup(n,'statsNodosCmts');
    if(!arr.length)return'';
    const field=MIRA_FIELDS.find(f=>f[0]===k);if(!field)return'';
    // Tecnología y Hub son texto. Mostrar valores únicos, sin promediar ni convertir a número.
    if(['mira_tecnologia','mira_nodo_cmts','mira_tipo','mira_cmts'].includes(k)){
      const values=[...new Set(arr.map(x=>mPath(x,field[2])).filter(x=>x!==null&&x!==undefined&&String(x).trim()!=='').map(x=>String(x).trim()))];
      return values.join(' / ');
    }
    const nums=arr.map(x=>({v:Number(mPath(x,field[2])),w:Number(x.cmStatus?.cmTot)||0,exists:mPath(x,field[2])!=null})).filter(x=>x.exists&&Number.isFinite(x.v));
    if(!nums.length)return'';
    if(k==='mira_total')return nums.reduce((a,x)=>a+x.v,0).toLocaleString('es-AR');
    const weights=nums.reduce((a,x)=>a+x.w,0);
    const value=weights>0?nums.reduce((a,x)=>a+x.v*x.w,0)/weights:nums.reduce((a,x)=>a+x.v,0)/nums.length;
    return k==='mira_up'?Math.round(value).toLocaleString('es-AR'):Number(value.toFixed(4)).toLocaleString('es-AR',{maximumFractionDigits:4});
  }
  // MIRA5 V22.56: importación manual, sin solicitudes cross-origin.
  const MIRA_STORE='ofsc_mira_import_v2256';
  let miraImportPosition=0,miraImportedAt=null;
  function trimMiraRow(r){
    if(!r||typeof r!=='object'||Array.isArray(r))return null;
    const allowed=['_id','nodo','nodoCmts','cmts','tipoNodo','hub','equipo','cmStatus','cmPartialService','cmIcmp','cmTrafico','cmPwr','cmSnr','cmFecDs','cmFecUs','cmFecDsOfdm','cmFecUsOfdm','cmFrecuencias','cmCant','cmPnm','region','poller'];
    return Object.fromEntries(allowed.filter(k=>Object.prototype.hasOwnProperty.call(r,k)).map(k=>[k,r[k]]));
  }
  function miraPersist(){
    // Guardamos solamente estadísticas consolidadas (sin Ds/Us individuales).
    const data={date:miraImportedAt||new Date().toISOString(),summary:[...new Map([...mira.summary.values()].flat().map(r=>[r._id||r.nodoCmts||r.nodo,r])).values()].map(trimMiraRow),full:[...new Map([...mira.full.values()].flat().map(r=>[r._id||r.nodo,r])).values()].map(trimMiraRow)};
    try{localStorage.setItem(MIRA_STORE,JSON.stringify(data));return true;}
    catch(e){setMiraStatus('MIRA5: almacenamiento lleno. Exportá menos nodos.');console.warn('localStorage MIRA5',e);return false;}
  }
  function miraRestore(){try{
    const saved=JSON.parse(localStorage.getItem(MIRA_STORE)||'null');if(!saved)return;
    for(const [map,rows] of [[mira.summary,saved.summary],[mira.full,saved.full]]){
      const all=Array.isArray(rows)?rows:[];
      // Registrar los prefijos exactos utilizados anteriormente y reconstruir posteriormente bajo demanda.
      for(const r of all){const n=upper(r.nodo||r.nodoCmts);if(n){if(!map.has(n))map.set(n,[]);map.get(n).push(r);}}
    }
    miraImportedAt=saved.date||null;
    miraSyncStatus();
  }catch(e){console.warn('MIRA5: no se pudo restaurar caché',e);}}
  function miraLookup(n,collection){
    const map=collection==='statsNodosCmts'?mira.summary:mira.full;
    if(map.has(n))return map.get(n);
    return [...new Map([...map.values()].flat().filter(r=>mMatch(n,r)).map(r=>[r._id||r.nodoCmts||r.nodo,r])).values()];
  }
  function miraSyncStatus(){const total=[...new Set([...mira.summary.values(),...mira.full.values()].flat().map(r=>upper(r.nodo||r.nodoCmts)))].length;setMiraStatus(miraImportedAt?'MIRA importado '+new Date(miraImportedAt).toLocaleString('es-AR')+' · '+total+' nodos':'MIRA5: sin datos importados · Activá VPN y usá Actualizar MIRA5');}
  function scheduleMiraScan(){ /* manual: jamás abrir peticiones automáticas a MIRA5 */ }
  async function refreshMira(){miraSyncStatus();renderMiraCells();}
  // Exportación ORIGINAL provista por el usuario. No agregar filtros: no está comprobado que export los admita.
  const MIRA_EXPORT_FIELDS=[['_id','id','text'],['nodoCmts','Link','text'],['nodoCmts','NodoCmts','text'],['nodo','Nodo','text'],['tipoNodo','Tipo Nodo','text'],['cmts','Cmts','text'],['cmStatus.cmTot','Total','int'],['cmStatus.cmUpPercent','Up%','int'],['cmStatus.cmTot','Total','int'],['cmPartialService.ofdmaPercent','OFDMA','int'],['equipo.equipoTipo.nombre','Tecnologia','text']];
  function miraExportUrl(){
    const params=new URLSearchParams({coll:'statsNodosCmts',model:JSON.stringify(MIRA_EXPORT_FIELDS.map(([name,label,formatter])=>({name,label,formatter})))});
    // PHP original utiliza la presencia del parámetro export sin valor.
    return 'https://mira5-gdt.telecentro.net.ar/controller_grid_mira_gral.php?'+params.toString()+'&export';
  }
  // Importación manual explícita: no solicitamos permisos de carpetas.
  // Descargar Excel abre la exportación oficial; Actualizar permite seleccionar el archivo.
  // MIRA5 exporta ocho columnas de texto inline en XLSX. Usamos JSZip para leer
  // únicamente sheet1.xml, sin construir el libro entero en XLSX-js-style.
  // Esto reduce fuertemente el uso de memoria para las ~16.800 filas.
  async function miraImportXlsx(file){
    const msg=$('#miraImportFeedback');
    if(!file)throw Error('Seleccioná el archivo export.xlsx.');
    if(!/\.xlsx$/i.test(file.name))throw Error('Seleccioná export.xlsx (formato XLSX).');
    if(!file.size)throw Error('El archivo está vacío.');
    if(file.size>40*1024*1024)throw Error('El archivo supera 40 MB; no se importará.');
    if(!window.JSZip)throw Error('No se cargó JSZip. Revisá la conexión a internet.');
    const progress=async text=>{msg.textContent=text;await new Promise(r=>setTimeout(r,0));};
    await progress('Procesando archivo… Leyendo '+file.name+' ('+(file.size/1048576).toFixed(2)+' MB)');
    let zip;
    try{zip=await window.JSZip.loadAsync(file);}catch(e){throw Error('El archivo no es un XLSX válido: '+e.message);}
    const sheet=zip.file('xl/worksheets/sheet1.xml');
    if(!sheet)throw Error('No se encontró la hoja de datos de MIRA5.');
    await progress('Procesando archivo… Descomprimiendo hoja Excel');
    const xml=await sheet.async('string');
    // El export de MIRA5 usa c t="inlineStr", con texto en is/t. La ruta
    // de respaldo también admite valores numéricos en <v> y sharedStrings.
    const shared=[];
    const sharedFile=zip.file('xl/sharedStrings.xml');
    if(sharedFile){
      const ss=await sharedFile.async('string');
      for(const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g))shared.push([...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(x=>x[1]).join(''));
    }
    const unescapeXml=t=>String(t??'').replace(/&(?:amp|lt|gt|quot|apos|#x[0-9a-f]+|#[0-9]+);/gi,x=>{
      const named={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
      if(named[x])return named[x];if(x.startsWith('&#')){const n=x[2].toLowerCase()==='x'?parseInt(x.slice(3,-1),16):parseInt(x.slice(2,-1),10);return Number.isFinite(n)?String.fromCodePoint(n):x;}return x;
    });
    const norm=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9%]/gi,'').toLowerCase();
    const numeric=x=>{const s=String(x??'').trim().replace(/%/g,'');if(!s)return NaN;return Number(s.includes(',')?s.replace(/\./g,'').replace(',','.'):s);};
    const columnIndex=letters=>[...letters].reduce((v,c)=>v*26+c.charCodeAt(0)-64,0)-1;
    let header=null,parsed=[],processed=0,skipped=0;
    for(const rm of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)){
      const cells={};
      for(const cm of rm[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)){
        const addr=/\br="([A-Z]+)\d+"/.exec(cm[1]);if(!addr)continue;
        const col=columnIndex(addr[1]);const ty=/\bt="([^"]+)"/.exec(cm[1])?.[1];
        const inline=[...cm[2].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(x=>x[1]).join('');
        const raw=/<v>([\s\S]*?)<\/v>/.exec(cm[2])?.[1]??'';
        cells[col]=unescapeXml(ty==='s'?shared[Number(raw)]:(ty==='inlineStr'?inline:(inline||raw)));
      }
      if(!header){
        const heads=Object.entries(cells);const lookup=(...names)=>heads.find(([k,v])=>names.map(norm).includes(norm(v)))?.[0];
        const n=lookup('Nodo'),nc=lookup('NodoCmts','Nodo Cmts'),total=lookup('Total','Total CM'),up=lookup('Up%','Up %','CM Up %');
        if(n!==undefined&&total!==undefined&&up!==undefined){header={n,nc,total,up,cmts:lookup('Cmts'),tipo:lookup('Tipo Nodo'),ofdma:lookup('OFDMA','OFDMA%'),tecnologia:lookup('Tecnologia','Tecnología','Equipo','Tecnologia MIRA')};}
        continue;
      }
      const value=k=>k===undefined?'':String(cells[k]??'').trim();
      const nodo=value(header.n),nc=value(header.nc)||nodo;
      if(!nodo&&!nc)continue;
      const total=numeric(value(header.total)),up=numeric(value(header.up));
      if(!Number.isFinite(total)||!Number.isFinite(up)){skipped++;continue;}
      parsed.push({nodo,nodoCmts:nc,cmts:value(header.cmts),tipoNodo:value(header.tipo),cmStatus:{cmTot:total,cmUpPercent:up},cmPartialService:{ofdmaPercent:numeric(value(header.ofdma))},equipo:{equipoTipo:{nombre:value(header.tecnologia)}}});
      processed++;
      if(processed%2000===0)await progress('Procesando archivo… '+processed.toLocaleString('es-AR')+' registros leídos');
    }
    if(!header)throw Error('El XLSX no contiene las columnas Nodo, Total y Up%.');
    if(!parsed.length)throw Error('No se encontraron registros válidos.');
    await progress('Procesando archivo… Guardando '+parsed.length.toLocaleString('es-AR')+' registros');
    miraImportOne({rows:parsed},'statsNodosCmts');
    miraFinalizeImport(parsed.length);
    msg.textContent='Importación completada: '+parsed.length.toLocaleString('es-AR')+' registros de '+file.name+'. '+(skipped?skipped+' filas omitidas.':'')+' Las columnas y el popup se actualizaron.';
    return parsed.length;
  }
  function miraDownloadExcel(){
    const msg=$('#miraImportFeedback');
    const w=window.open(miraExportUrl(),'_blank','noopener,noreferrer');
    msg.textContent=w?'MIRA5 abrió la exportación. Cuando termine la descarga, pulsá Actualizar y elegí el Excel.':'Chrome bloqueó la pestaña. Permití ventanas emergentes para este sitio e intentá Descargar Excel nuevamente.';
  }
  function miraChooseExcel(){
    $('#miraImportFeedback').textContent='Seleccioná export.xlsx desde Descargas.';
    $('#miraImportFallback').click();
  }
  function miraImportOne(data,coll){
    if(!data||!Array.isArray(data.rows))throw Error('El archivo no contiene un array rows de MIRA5.');
    const rows=data.rows.map(trimMiraRow).filter(r=>r&&(r.nodo||r.nodoCmts));
    const map=coll==='statsNodosCmts'?mira.summary:mira.full;
    const all=[...map.values()].flat();const merged=new Map(all.map(r=>[String(r._id||r.nodoCmts||r.nodo),r]));
    for(const r of rows)merged.set(String(r._id||r.nodoCmts||r.nodo),r);
    map.clear();for(const r of merged.values()){const key=upper(r.nodo||r.nodoCmts);if(!map.has(key))map.set(key,[]);map.get(key).push(r);}
    return rows.length;
  }
  function miraFinalizeImport(count){miraImportedAt=new Date().toISOString();const saved=miraPersist();miraSyncStatus();renderMiraCells();$('#miraImportFeedback').textContent=`Importados ${count} registros. ${saved?'Guardados en este navegador.':'No pudieron guardarse: almacenamiento lleno.'} Las columnas y el popup ya están actualizados.`;}
  function openMiraImporter(){
    $('#miraImportFeedback').textContent='Primero descargá el Excel, después elegilo con Actualizar. No se requieren permisos para carpetas.';
    $('#miraImportModal').classList.remove('hidden');
  }
  $('#btnMiraImport').onclick=openMiraImporter;
  $('#miraImportClose').onclick=()=>$('#miraImportModal').classList.add('hidden');
  $('#miraImportDownload').onclick=miraDownloadExcel;
  $('#miraImportUpdate').onclick=miraChooseExcel;
  $('#miraImportFallback').onchange=async e=>{
    const file=e.target.files?.[0];if(!file)return;
    const btn=$('#miraImportUpdate');btn.disabled=true;btn.textContent='Procesando…';
    try{await miraImportXlsx(file);}catch(err){$('#miraImportFeedback').textContent='Error al importar Excel: '+err.message;}
    finally{btn.disabled=false;btn.textContent='Actualizar';e.target.value='';}
  };
  miraRestore();
  function setMiraStatus(s){const el=$('#miraLastQuery');if(el)el.textContent=s;}
  function renderMiraCells(){document.querySelectorAll('#opTbody tr[data-task]').forEach(tr=>{const r=state.filtered.find(x=>taskId(x)===tr.dataset.task);if(!r)return;tr.querySelectorAll('[data-column^="mira_"]').forEach(td=>{const key=td.dataset.column;td.innerHTML=cellHtml(r,key);});});}
  function showMiraPopup(n){const modal=$('#miraModal');const title=$('#miraPopupTitle'),body=$('#miraPopupBody');title.textContent='MIRA5 · '+n;const summary=miraLookup(upper(n),'statsNodosCmts');const metric=(k)=>{const r={Nodo:n};return miraValue(r,k) || (miraValue(r,k)===0?'0':'—');};
    body.innerHTML=`<p class="mira-vpn">Para ver valores o estado del nodo, recordá activar la VPN.</p><div class="mira-popup-grid">${MIRA_FIELDS.filter(([k])=>mira.selected.has(k)).map(([k,l])=>`<div><small>${esc(l)}</small><strong>${esc(metric(k))}</strong></div>`).join('')}</div><p class="muted">${summary.length} registros Nodo/CMTS importados desde Excel. Total CM se suma; CM Up % se calcula ponderando por cantidad de CM.</p>`;modal.classList.remove('hidden');}
  function showMiraSettings(){const p=$('#miraSettingsBody');p.innerHTML=MIRA_FIELDS.map(([k,l])=>`<label><input type="checkbox" value="${k}" ${mira.selected.has(k)?'checked':''}> ${esc(l)}</label>`).join('');p.querySelectorAll('input').forEach(el=>el.onchange=()=>{el.checked?mira.selected.add(el.value):mira.selected.delete(el.value);localStorage.setItem(miraSettingsKey,JSON.stringify([...mira.selected]));});$('#miraSettingsModal').classList.remove('hidden');}
  $('#miraPopupClose').onclick=()=>$('#miraModal').classList.add('hidden');$('#miraSettingsClose').onclick=()=>$('#miraSettingsModal').classList.add('hidden');$('#miraGear').onclick=showMiraSettings;
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){$('#miraModal').classList.add('hidden');$('#miraSettingsModal').classList.add('hidden');$('#miraImportModal').classList.add('hidden');}});
  // Sin polling: la actualización es explícitamente manual mediante importación.

  loadSavedExclusions();ensureOperationalDates();buildAllMultis();installTableHorizontalScroller();applyTableZoom();applyHistoryZoom();loadAllOperativo();loadControlStatus(false);
})();





