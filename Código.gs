/**



 * OFSC -> Google Sheets



 * Snapshot cada 30 minutos.



 *



 * Fuente: Cloudflare Worker /api/final_range



 * El Apps Script NO aplica lógica de negocio: solamente replica.



 */







const OFSC_SYNC = {



  WORKER_BASE_URL: 'https://yellow-violet-cafe.ddan48.workers.dev',



  SPREADSHEET_ID: '1TXkfFiU1Dv-4dR7cSGMOR-OOx88TAQtDJSK6s_TTYAs',



  DATA_SHEET: 'DATA',



  CONTROL_SHEET: 'CONTROL',







  TREES: [



    'USAP',



    'INFRA',



    'USAC',



    'EDF',



    'USAPT',



    'MBR-Preventivo',



    'MIC',



  'gomra.implementaciones'



  ],







  DAYS_BACK: 6,



  DAYS_FORWARD: 30,







  PREFERRED_COLUMNS: [



    'Tarea',



    'Creado',



    'CreadoExacto',



    'Afectacion',



    'ComplementoPendiente',



    'EventoTableau',



    'Nodo',



    'Tipif',



    'TipificacionTarea',



    'Estado',



    'Capa',



    'SubCapa',



    'Origen',



    'TicketEvento',



    'SiglaEvento',



    'FechaEvento',



    'AntiguedadDias',



    'AntiguedadEventoDias',
    'AntiguedadEventoPadreDias',



    'Contratista',



    'ContratistaFuente',



    'VecesSuspendida',



    'TotalAsignaciones',



    'Agendado',



    'StartTime',



    'EndTime',



    'FechaEfectiva',



    'Tecnico',



    'IDRecurso',



    'Arbol',



    'activityId',



    'resourceId',



    'status',



    'activityType',



    'ResolvedBy'



  ]



};











/**



 * Función que debe usar el trigger de 30 minutos.



 */



// Sincronización incremental operativa. El trigger existente mantiene este nombre.

/**
 * Protección de tipos para las hojas de datos.
 * ISO y otros identificadores se conservan como texto, coordenadas/duración numéricos.
 * Los valores originales de conteos no se recalculan ni se modifican.
 */
const ETA_COLUMN_FORMATS = {
  text: [
    'Tarea','TicketEvento','EventoTableau','apptNumber','IDRecurso','resourceId',
    'Creado','CreadoExacto','FechaEvento','Agendado','StartTime','EndTime',
    'FechaEfectiva','date','startTime','endTime','routeStartTime','routeEndTime',
    'routeReactivationTime'
  ],
  decimal: ['longitude','latitude','duration'],
  // Son contadores enteros, nunca fechas.
  integer: ['travelTime','TotalAsignaciones','VecesSuspendida']
};
function etaPrepareColumnFormats_(sheet, headers, rowCount) {
  const n = Math.max(1, rowCount);
  headers.forEach(function(header, i) {
    let format = null;
    if (ETA_COLUMN_FORMATS.text.indexOf(header) >= 0) format = '@';
    else if (ETA_COLUMN_FORMATS.decimal.indexOf(header) >= 0) format = '0.############';
    else if (ETA_COLUMN_FORMATS.integer.indexOf(header) >= 0) format = '0';
    if (format) sheet.getRange(2, i+1, n, 1).setNumberFormat(format);
  });
}
/** Recupera contadores almacenados erróneamente como fecha serial de Sheets.
 * La fecha base de Sheets es 1899-12-30: 1899-12-31 => 1.
 * Solo aplica a las dos columnas de conteos; no altera fechas operativas.
 */
function etaCounterValue_(value) {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : '';
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return '';
    const day = Utilities.formatDate(value, 'America/Argentina/Buenos_Aires', 'yyyy-MM-dd');
    return etaSerialDay_(day);
  }
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const dateMatch = s.match(/^(18\d{2}|19\d{2}|20\d{2})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (dateMatch) {
    // Los ISO que provienen de Sheets pueden incluir el desfase UTC local.
    const d = new Date(s);
    const localDay = !isNaN(d.getTime()) && s.includes('T')
      ? Utilities.formatDate(d, 'America/Argentina/Buenos_Aires', 'yyyy-MM-dd')
      : s.slice(0,10);
    return etaSerialDay_(localDay);
  }
  // No convertir valores desconocidos silenciosamente a cero.
  return value;
}
function etaSerialDay_(ymd) {
  const m=String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const days=Math.round((Date.UTC(+m[1],+m[2]-1,+m[3])-Date.UTC(1899,11,30))/86400000);
  return days >= 0 && days <= 10000 ? days : '';
}

function etaScalarForSheet_(value, header) {
  if (header === 'TotalAsignaciones' || header === 'VecesSuspendida') return etaCounterValue_(value);
  if (value === undefined || value === null) return '';
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? '' : Utilities.formatDate(value,'America/Argentina/Buenos_Aires',"yyyy-MM-dd'T'HH:mm:ss");
  }
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') {
    // Don't add an extra quote around valid ISO text; strip ONLY serialized wrappers.
    const v = value.trim();
    if (/^\".*\"$/.test(v) && /^\"\d{4}-\d\d-\d\d/.test(v)) {
      try { const decoded = JSON.parse(v); if (typeof decoded === 'string') return decoded; } catch(e) {}
    }
    if (ETA_COLUMN_FORMATS.decimal.indexOf(header) >= 0 && v !== '' && /^-?\d+(?:\.\d+)?$/.test(v)) {
      return Number(v);
    }
  }
  return value;
}
// Diagnóstico de solo lectura: muestra cómo Google Sheets tipó cada columna.
function diagnosticarTiposETA() {
  const ss=getOfscSpreadsheet_(), result={};
  [OFSC_SYNC.DATA_SHEET,ETA_INC.EVENTS_SHEET].forEach(function(name){
    const sh=ss.getSheetByName(name); if(!sh || sh.getLastRow()<2){result[name]='SIN DATOS';return;}
    const heads=sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(String);
    const fields=['longitude','latitude','duration','StartTime','startTime','EndTime','endTime','FechaEfectiva','Agendado','VecesSuspendida','TotalAsignaciones'];
    result[name]={filas:sh.getLastRow()-1, columnas:{}};
    fields.forEach(function(field){const i=heads.indexOf(field);if(i<0)return;
      const raw=sh.getRange(2,i+1,Math.min(10,sh.getLastRow()-1),1).getValues().map(x=>x[0]);
      result[name].columnas[field]=raw.map(x=>({tipo:x instanceof Date?'Date':typeof x, valor:x instanceof Date?x.toISOString():x}));
    });
  });
  console.log(JSON.stringify(result));return result;
}

function syncOfscToSheet() {

  return etaSyncIncremental_('DATA');

}



// Nueva sincronización separada. Crear un disparador temporal para completar

// el backfill inicial y luego uno diario o cada 30 minutos.

function syncOfscEventosMP() {

  return etaSyncIncremental_('EVENTOS');

}



// Los triggers se gestionan desde 04_ProgramacionV20.gs.







/**



 * Ejecutar manualmente para comprobar conectividad.



 */



function probarWorker() {



  const range = buildDateRange_(0, 1);







  const url =



    OFSC_SYNC.WORKER_BASE_URL +



    '/api/final_range' +



    '?from=' + range.from +



    '&to=' + range.to +



    '&tree=USAC';







  const response = UrlFetchApp.fetch(



    url,



    {



      muteHttpExceptions: true



    }



  );







  console.log(



    response.getResponseCode()



  );







  console.log(



    response.getContentText().substring(0, 5000)



  );



}











function buildDateRange_(daysBack, daysForward) {



  const tz = Session.getScriptTimeZone() || 'America/Argentina/Buenos_Aires';







  const today = new Date();







  const from = new Date(today);



  from.setDate(



    from.getDate() - daysBack



  );







  const to = new Date(today);



  to.setDate(



    to.getDate() + daysForward



  );







  return {



    from:



      Utilities.formatDate(



        from,



        tz,



        'yyyy-MM-dd'



      ),



    to:



      Utilities.formatDate(



        to,



        tz,



        'yyyy-MM-dd'



      )



  };



}











function buildHeaders_(items) {



  const all = {};







  items.forEach(function(item) {



    Object.keys(item).forEach(function(key) {



      all[key] = true;



    });



  });







  const preferred =



    OFSC_SYNC.PREFERRED_COLUMNS.filter(



      function(key) {



        return all[key];



      }



    );







  const preferredSet = {};







  preferred.forEach(function(key) {



    preferredSet[key] = true;



  });







  const extras =



    Object.keys(all)



      .filter(function(key) {



        return !preferredSet[key];



      })



      .sort();







  return preferred.concat(extras);



}











function buildValues_(items, headers) {
  return items.map(function(item){
    return headers.map(function(header){
      return etaScalarForSheet_(item[header], header);
    });
  });
}

function replaceDataSheet_(ss, headers, values) {



  let tmp =



    ss.getSheetByName('DATA_TMP');







  if (!tmp) {



    tmp = ss.insertSheet('DATA_TMP');



  }







  tmp.clearContents();







  const allRows = [headers].concat(values);
  etaPrepareColumnFormats_(tmp, headers, values.length);







  if (allRows.length && headers.length) {



    tmp



      .getRange(



        1,



        1,



        allRows.length,



        headers.length



      )



      .setValues(allRows);



  }







  tmp.setFrozenRows(1);







  let data =



    ss.getSheetByName(



      OFSC_SYNC.DATA_SHEET



    );







  if (!data) {



    data =



      ss.insertSheet(



        OFSC_SYNC.DATA_SHEET



      );



  }







  // Sólo reemplazamos DATA después de descargar y construir



  // correctamente el snapshot completo.



  data.clearContents();
  etaPrepareColumnFormats_(data, headers, values.length);







  if (allRows.length && headers.length) {



    data



      .getRange(



        1,



        1,



        allRows.length,



        headers.length



      )



      .setValues(allRows);



  }







  data.setFrozenRows(1);







  tmp.clearContents();



}











/**



 * Reemplaza updateControl_ existente.



 * - conserva valores previos;



 * - registra automáticamente fechaUltimoError y ultimoError;



 * - muestra fechas con fecha + hora en la hoja CONTROL.



 */



function updateControl_(ss, values) {



  var sheetName = (typeof OFSC_SYNC !== 'undefined' && OFSC_SYNC.CONTROL_SHEET) ? OFSC_SYNC.CONTROL_SHEET : 'CONTROL';



  var sheet = ss.getSheetByName(sheetName);



  if (!sheet) sheet = ss.insertSheet(sheetName);







  var current = {};



  var lastRow = sheet.getLastRow();



  if (lastRow > 0) {



    sheet.getRange(1,1,lastRow,2).getValues().forEach(function(row){



      if (row[0]) current[String(row[0])] = row[1];



    });



  }







  Object.keys(values || {}).forEach(function(key){ current[key] = values[key]; });







  if (String((values || {}).estado || '').toUpperCase() === 'ERROR') {



    current.fechaUltimoError = (values && values.ultimoIntento) || new Date();



    current.ultimoError = String((values && values.error) || 'Error sin detalle');



  }







  var preferredOrder = [



    'estado','ultimoIntento','ultimaActualizacionExitosa','desde','hasta','registros','arboles','duracionSegundos','origen','fechaUltimoError','ultimoError','error'



  ];



  var seen = {};



  var keys = [];



  preferredOrder.forEach(function(k){if(Object.prototype.hasOwnProperty.call(current,k)){keys.push(k);seen[k]=true;}});



  Object.keys(current).sort().forEach(function(k){if(!seen[k])keys.push(k);});







  var rows = keys.map(function(key){return [key,current[key]];});



  sheet.clearContents();



  if (rows.length) sheet.getRange(1,1,rows.length,2).setValues(rows);







  sheet.getRange(1,1,Math.max(1,rows.length),1).setFontWeight('bold').setBackground('#162230').setFontColor('#ffffff');



  sheet.getRange(1,2,Math.max(1,rows.length),1).setWrap(true).setNumberFormat('General');



  keys.forEach(function(key,index){



    var value=current[key];



    if (value instanceof Date && !isNaN(value.getTime())) {



      sheet.getRange(index+1,2).setNumberFormat('dd/mm/yyyy hh:mm:ss');



    }



  });



  sheet.setFrozenColumns(1);



  sheet.setColumnWidth(1,220);



  sheet.setColumnWidth(2,520);



}







/** Ejecutar una vez si querés aplicar el formato nuevo a CONTROL sin esperar al próximo sync. */



function formatearControlAhora() {



  updateControl_(getOfscSpreadsheet_(), {});



}















/**



 * OFSC - V22.19 CONTROL + PRIORIDAD FORZADA



 *



 * IMPLEMENTACIÓN:



 * 1) Reemplazar la función doGet(e) actual por esta versión.



 * 2) Reemplazar la función updateControl_(ss, values) actual por la incluida al final.



 *



 * No modifica syncOfscToSheet() ni actualizarTableauCache().



 * El endpoint operativo sigue leyendo solamente DATA.



 * ?mode=control devuelve el estado de CONTROL + Tableau/PDF.



 */



/**



 * OFSC - V22.20 CONTROL + PRIORIDAD ESTÁNDAR



 *



 * IMPLEMENTACIÓN:



 * 1) Reemplazar la función doGet(e) actual por esta versión.



 * 2) Reemplazar la función updateControl_(ss, values) actual por la incluida al final.



 *



 * No modifica syncOfscToSheet() ni actualizarTableauCache().



 * El endpoint operativo sigue leyendo solamente DATA.



 * ?mode=control devuelve el estado de CONTROL + Tableau/PDF.



 */



function doGet(e) {



  try {



    var params = (e && e.parameter) || {};



    var mode = String(params.mode || '').trim().toLowerCase();







    if (mode === 'control') {



      return outputJson_(buildFrontendControlStatus_());



    }







    var from = String(params.from || '').trim();



    var to = String(params.to || '').trim();



    var all = String(params.all || '').trim() === '1';



    var compact = String(params.compact || '').trim() === '1';
    var sinNotas = ['1','true','yes'].indexOf(String(params.sin_notas || params.sinNotas || '').trim().toLowerCase()) >= 0;



    var page = Math.max(1, parseInt(params.page || '1', 10) || 1);



    var limit = Math.min(1000, Math.max(1, parseInt(params.limit || '500', 10) || 500));







    if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) ||



        (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) ||



        (from && to && from > to)) {



      return outputJson_({ok:false,error:'from/to: usar YYYY-MM-DD, from <= to'});



    }







    var ss = getOfscSpreadsheet_();



    var sheet = ss.getSheetByName(OFSC_SYNC.DATA_SHEET || 'DATA');



    if (!sheet || sheet.getLastRow() < 1) {



      return outputJson_({ok:false,error:'Pestaña DATA vacía o inexistente'});



    }







    // Una sola lectura de DATA por request.



    var values = sheet.getDataRange().getValues();



    if (!values.length) {



      return outputJson_({ok:true,source:'google_sheet',mode:all?'all':'paged',all:all,compact:compact,from:from||null,to:to||null,page:1,limit:all?0:limit,total:0,totalPages:1,count:0,items:[]});



    }







    var headers = values[0].map(function(h){ return String(h || '').trim(); });



    var idx = {};



    for (var h=0; h<headers.length; h++) if (headers[h]) idx[headers[h]] = h;







    var effectiveIdx = idx['FechaEfectiva'];



    if (effectiveIdx === undefined) {



      return outputJson_({ok:false,error:'No existe columna FechaEfectiva en DATA'});



    }







    var excludedEventSiglas = {



      MT:true, ME:true, FP:true, LK:true, EN:true,



      MF:true, RR:true, MZ:true, YI:true, YP:true



    };



    var excludedContractors = {DDL:true, PERSONAL_PROPIO:true};



    var excludedTaskSiglas = {RIL:true, MPR:true, CFO:true, ATT:true};







    var compactHeaders = [



      'Tarea','Creado','CreadoExacto','Afectacion','XA_Priority','Nodo','Tipif','TipificacionTarea',



      'Estado','Capa','SubCapa','Origen','TicketEvento','EventoTableau','SiglaEvento',



      'FechaEvento','AntiguedadDias','AntiguedadEventoDias','AntiguedadEventoPadreDias','Contratista','ContratistaFuente',
      'VecesSuspendida','TotalAsignaciones',



      'Agendado','StartTime','EndTime','FechaEfectiva','Tecnico','IDRecurso','Arbol',



      'activityId','resourceId','status','activityType','date','latitude','longitude',



      'XA_Node','XA_Address','Address','address','City','city'



    ];







    var selectedHeaders = compact



      ? compactHeaders.filter(function(name){ return idx[name] !== undefined; })



      : headers.filter(function(name){ return !!name; });







    if (sinNotas) selectedHeaders = selectedHeaders.filter(function(h){return h !== 'XA_Activity_Notes' && h !== 'closure_notes';});

    function cellYmd_(value) {



      if (value instanceof Date && !isNaN(value.getTime())) {



        return Utilities.formatDate(value, 'America/Argentina/Buenos_Aires', 'yyyy-MM-dd');



      }



      var s = String(value == null ? '' : value).trim();



      if (!s) return '';



      var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);



      if (m) return m[1]+'-'+m[2]+'-'+m[3];



      m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);



      if (m) return m[3]+'-'+('0'+m[2]).slice(-2)+'-'+('0'+m[1]).slice(-2);



      return '';



    }







    function normalizedValue_(value) {



      return value instanceof Date



        ? Utilities.formatDate(value,'America/Argentina/Buenos_Aires',"yyyy-MM-dd'T'HH:mm:ss")



        : value;



    }







    function eventSiglaForRow_(row) {



      var s = '';



      if (idx['SiglaEvento'] !== undefined) s = String(row[idx['SiglaEvento']] || '').trim().toUpperCase();



      if (s) return s;



      var candidates = ['TicketEvento','EventoTableau'];



      for (var c=0; c<candidates.length; c++) {



        var ci = idx[candidates[c]];



        if (ci === undefined) continue;



        var code = String(row[ci] || '').trim().toUpperCase();



        var m = code.match(/^\d{6}([A-Z]{2})/);



        if (m) return m[1];



      }



      return '';



    }







    var filteredRows = [];



    for (var r=1; r<values.length; r++) {



      var row = values[r];



      var ymd = cellYmd_(row[effectiveIdx]);



      if (from && (!ymd || ymd < from)) continue;



      if (to && (!ymd || ymd > to)) continue;



      var evSigla = eventSiglaForRow_(row);



      if (evSigla && excludedEventSiglas[evSigla]) continue;







      if (idx['Contratista'] !== undefined) {



        var cont = String(row[idx['Contratista']] || '').trim().toUpperCase();



        if (excludedContractors[cont]) continue;



      }



      if (idx['Tipif'] !== undefined) {



        var taskSigla = String(row[idx['Tipif']] || '').trim().toUpperCase();



        if (excludedTaskSiglas[taskSigla]) continue;



      }



      filteredRows.push(row);



    }







    var total = filteredRows.length;



    var selectedRows = all



      ? filteredRows



      : filteredRows.slice((page-1)*limit, (page-1)*limit + limit);







    var items = [];



    for (var i=0; i<selectedRows.length; i++) {



      var src = selectedRows[i];



      var item = {};



      for (var k=0; k<selectedHeaders.length; k++) {



        var name = selectedHeaders[k];



        item[name] = (name === 'TotalAsignaciones' || name === 'VecesSuspendida') ? etaCounterValue_(src[idx[name]]) : normalizedValue_(src[idx[name]]);



      }



      items.push(item);



    }







    return outputJson_({



      ok:true,



      source:'google_sheet',



      mode:all?'all':'paged',



      all:all,



      compact:compact,



      excludedEventSiglas:Object.keys(excludedEventSiglas),



      excludedContractors:Object.keys(excludedContractors),



      excludedTaskSiglas:Object.keys(excludedTaskSiglas),



      from:from||null,



      to:to||null,



      page:all?1:page,



      limit:all?total:limit,



      total:total,



      totalPages:all?1:Math.max(1,Math.ceil(total/limit)),



      count:items.length,



      items:items



    });



  } catch(error) {



    console.error(error);



    return outputJson_({ok:false,error:String(error && error.message || error)});



  }



}







function getOfscSpreadsheet_() {



  if (typeof OFSC_SYNC !== 'undefined' && OFSC_SYNC.SPREADSHEET_ID) {



    return SpreadsheetApp.openById(OFSC_SYNC.SPREADSHEET_ID);



  }



  var ss = SpreadsheetApp.getActiveSpreadsheet();



  if (!ss) throw new Error('No se pudo resolver el Spreadsheet OFSC.');



  return ss;



}







function isoControlValue_(value) {



  if (value instanceof Date && !isNaN(value.getTime())) return value.toISOString();



  return value === null || value === undefined ? '' : value;



}







function readControlObject_(ss) {



  var sheetName = (typeof OFSC_SYNC !== 'undefined' && OFSC_SYNC.CONTROL_SHEET) ? OFSC_SYNC.CONTROL_SHEET : 'CONTROL';



  var sh = ss.getSheetByName(sheetName);



  var result = {};



  if (!sh || sh.getLastRow() < 1) return result;



  sh.getRange(1,1,sh.getLastRow(),Math.min(2,Math.max(2,sh.getLastColumn()))).getValues().forEach(function(row){



    var key = String(row[0] || '').trim();



    if (key) result[key] = isoControlValue_(row[1]);



  });



  return result;



}







function maxTableauCapture_(ss) {



  var sh = ss.getSheetByName('TABLEAU_CACHE');



  if (!sh || sh.getLastRow() < 2) return {registros:0,ultima:''};



  var values = sh.getDataRange().getValues();



  var headers = values[0].map(function(x){return String(x||'').trim();});



  var ix = headers.indexOf('UltimaCapturaPDF');



  var max = null;



  if (ix >= 0) {



    for (var i=1;i<values.length;i++) {



      var v=values[i][ix];



      var d=v instanceof Date?v:new Date(String(v||''));



      if (!isNaN(d.getTime()) && (!max || d>max)) max=d;



    }



  }



  return {registros:Math.max(0,values.length-1),ultima:max?max.toISOString():''};



}







function buildFrontendControlStatus_() {



  var ss = getOfscSpreadsheet_();



  var control = readControlObject_(ss);



  var props = PropertiesService.getScriptProperties();



  var lastVersion = String(props.getProperty('TABLEAU_CACHE_LAST_VERSION') || '');



  var tableau = maxTableauCapture_(ss);



  var currentPdf = null;



  var currentVersion = '';



  var pdfError = '';







  try {



    if (typeof tableauCacheConfig_ === 'function' && typeof tableauCacheResolvePdf_ === 'function') {



      var conf = tableauCacheConfig_();



      var pdf = tableauCacheResolvePdf_(conf);



      if (pdf) {



        var updated = pdf.getLastUpdated();



        currentPdf = {



          archivo: pdf.getName(),



          id: pdf.getId(),



          pdfModificado: updated ? updated.toISOString() : ''



        };



        currentVersion = pdf.getId() + '|' + (updated ? updated.toISOString() : '');



      }



    }



  } catch (e) {



    pdfError = String(e && e.message || e);



  }







  var lastProcessedStamp = '';



  if (lastVersion.indexOf('|') >= 0) lastProcessedStamp = lastVersion.split('|').slice(1).join('|');



  var hasNew = currentVersion ? currentVersion !== lastVersion : null;



  var tableauStatus = pdfError ? 'ERROR' : (hasNew === true ? 'PENDIENTE' : (lastVersion ? 'ACTUALIZADO' : 'SIN DATOS'));







  return {



    ok:true,



    mode:'control',



    control:control,



    tableau:{



      estado:tableauStatus,



      archivo:currentPdf ? currentPdf.archivo : '',



      pdfModificado:currentPdf ? currentPdf.pdfModificado : '',



      ultimaVersionProcesada:lastProcessedStamp,



      ultimaActualizacionReal:tableau.ultima || lastProcessedStamp,



      hayNuevaVersion:hasNew,



      registrosCache:tableau.registros,



      error:pdfError



    }



  };



}











function dateCellYmd_(value) {



  if (value instanceof Date) {



    return Utilities.formatDate(value, 'America/Argentina/Buenos_Aires', 'yyyy-MM-dd');



  }



  var raw = String(value == null ? '' : value).trim();



  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0,10);



  var m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);



  if (m) return m[3]+'-'+('0'+m[2]).slice(-2)+'-'+('0'+m[1]).slice(-2);



  return '';



}







function outputJson_(obj) {



  return ContentService.createTextOutput(JSON.stringify(obj))



    .setMimeType(ContentService.MimeType.JSON);



}















// El histórico Oracle se programa exclusivamente en Cloudflare.



// NO ejecutar funciones antiguas de Apps Script para iniciar o reanudar histórico.









// Global: una sola fila por Tarea aunque el Worker se consulte por ramas.

// No altera los contadores internos calculados en cada rama.

function ofscConsolidarEntreArboles_(items) {

  var out = new Map();

  function key(x) { return String(x.Tarea || x.apptNumber || '').trim().toUpperCase(); }

  function terminal(x) {

    var s = String(x.Estado || x.status || '').trim().toUpperCase();

    return ['COMPLETADA','COMPLETADO','COMPLETED','CANCELADA','CANCELADO',

      'CANCELLED','CANCELED','NO REALIZADA','NO REALIZADO','NOTDONE','NOT DONE'].indexOf(s) >= 0;

  }

  function timestamp(x) {

    var t = x.EndTime || x.endTime || x.StartTime || x.startTime || x.FechaEfectiva || x.date || '';

    return String(t).replace('T',' ').slice(0,19);

  }

  items.forEach(function(x) {

    var k = key(x);

    if (!k) return;

    var prev = out.get(k);

    if (!prev) { out.set(k,x); return; }

    var xT = terminal(x), pT = terminal(prev);

    if ((xT && !pT) ||

        (xT === pT && (timestamp(x) > timestamp(prev) ||

         (timestamp(x) === timestamp(prev) && Number(x.activityId || 0) > Number(prev.activityId || 0))))) {

      out.set(k,x);

    }

  });

  return Array.from(out.values());

}









/**

 * Incremental 2026-10. IMPORTANTE:

 * - DATA: dos días hacia atrás + treinta hacia adelante, histórico consolidado.

 * - EVENTOS: desde dos días antes del primer día del mes hasta diez después

 *   del último día; en sucesivas cargas reconsulta sólo hoy-2 y futuro.

 * - Carga inicial EVENTOS paginada por tramos, con checkpoint por mes.

 * - Los datos del pasado no se borran; se reemplaza sólo la ventana consultada.

 * - No se escribe ninguna ventana si falla algún árbol.

 */

const ETA_INC = {
  TZ: 'America/Argentina/Buenos_Aires',
  EVENTS_SHEET: 'EVENTOS_MP_ME_MF_MT',
  EVENT_CODES: ['MP','ME','MF','MT'],
  DATA_LOOKBACK_DAYS: 6,
  EVENTS_LOOKBACK_DAYS: 2,
  OPERATIVE_FORWARD_DAYS: 30,
  HISTORY_LOOKBACK_DAYS: 30,
  HISTORY_CHUNK_DAYS: 4,
  HISTORY_CHUNKS_PER_RUN: 1
};



function etaYmd_(d) {

  return Utilities.formatDate(d, ETA_INC.TZ, 'yyyy-MM-dd');

}

function etaDate_(ymd) {

  const a = String(ymd).split('-').map(Number);

  return new Date(a[0], a[1]-1, a[2], 12, 0, 0);

}

function etaPlus_(ymd, days) {

  const d = etaDate_(ymd);

  d.setDate(d.getDate() + days);

  return etaYmd_(d);

}

function etaYmdCell_(v) {

  if (v instanceof Date && !isNaN(v.getTime())) return etaYmd_(v);

  const s = String(v == null ? '' : v).trim();

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (m) return m[1]+'-'+m[2]+'-'+m[3];

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);

  if (m) return m[3]+'-'+('0'+m[2]).slice(-2)+'-'+('0'+m[1]).slice(-2);

  return '';

}

function etaEventSigla_(x) {

  const direct = String(x.SiglaEvento || '').trim().toUpperCase();

  if (direct) return direct;

  const ev = String(x.TicketEvento || x.XA_Eventticket || x.EventoTableau || '').trim().toUpperCase();

  const m = ev.match(/^\d{6}([A-Z]{2})/);

  return m ? m[1] : '';

}

function etaIsSpecial_(x) {

  return ETA_INC.EVENT_CODES.indexOf(etaEventSigla_(x)) >= 0;

}

function etaParseRows_(sheet) {

  if (!sheet || sheet.getLastRow() < 2) return [];

  const vals = sheet.getDataRange().getValues();

  const headers = vals[0].map(x => String(x || '').trim());

  return vals.slice(1).filter(r => r.some(x => x !== '' && x !== null))

    .map(r => {

      const obj = {};

      headers.forEach((h, i) => { if (h) obj[h] = r[i]; });

      return obj;

    });

}

function etaFetchTrees_(from, to) {

  const all = [];

  const errors = [];

  for (let i=0; i<OFSC_SYNC.TREES.length; i++) {

    const tree = OFSC_SYNC.TREES[i];

    const url = OFSC_SYNC.WORKER_BASE_URL + '/api/final_range?from=' +

      encodeURIComponent(from) + '&to=' + encodeURIComponent(to) +

      '&tree=' + encodeURIComponent(tree);

    try {

      console.log('ETA ' + (i+1) + '/' + OFSC_SYNC.TREES.length +

        ' ' + tree + ' ' + from + ' -> ' + to);

      const resp = UrlFetchApp.fetch(url, {

        method: 'get', muteHttpExceptions: true, followRedirects: true,

        headers: {'Accept':'application/json'}

      });

      const code = resp.getResponseCode();

      if (code < 200 || code >= 300) {

        throw new Error('HTTP '+code+' '+resp.getContentText().slice(0,350));

      }

      const payload = JSON.parse(resp.getContentText());

      if (!payload.ok || !Array.isArray(payload.items)) {

        throw new Error('JSON incompleto o inválido '+JSON.stringify(payload).slice(0,350));

      }

      all.push(...payload.items);

    } catch (err) {

      errors.push(tree+': '+String(err && err.message || err));

    }

  }

  if (errors.length) throw new Error('Sin cambios por falla en árbol(es): '+errors.join(' | '));

  return ofscConsolidarEntreArboles_(all);

}



// La escritura usa hoja auxiliar y conserva el esquema de columnas vigente.

// No se modifica ni se borra la hoja histórica al fallar una descarga.

function etaWriteRows_(ss, sheetName, items) {

  const headers = buildHeaders_(items);

  if (!headers.length) return;

  const values = buildValues_(items, headers);

  const existing = ss.getSheetByName(sheetName);

  const tmpName = sheetName === OFSC_SYNC.DATA_SHEET ? 'DATA_TMP' : 'EVENTOS_MP_TMP';

  let tmp = ss.getSheetByName(tmpName);

  if (!tmp) tmp = ss.insertSheet(tmpName);

  tmp.clearContents();

  const all = [headers].concat(values);

  if (tmp.getMaxRows() < all.length) tmp.insertRowsAfter(tmp.getMaxRows(), all.length-tmp.getMaxRows());

  if (tmp.getMaxColumns() < headers.length) tmp.insertColumnsAfter(tmp.getMaxColumns(), headers.length-tmp.getMaxColumns());

  etaPrepareColumnFormats_(tmp, headers, values.length);
  tmp.getRange(1,1,all.length,headers.length).setValues(all);

  tmp.setFrozenRows(1);

  let dest = existing || ss.insertSheet(sheetName);

  if (dest.getMaxRows() < all.length) dest.insertRowsAfter(dest.getMaxRows(), all.length-dest.getMaxRows());

  if (dest.getMaxColumns() < headers.length) dest.insertColumnsAfter(dest.getMaxColumns(), headers.length-dest.getMaxColumns());

  dest.clearContents();

  etaPrepareColumnFormats_(dest, headers, values.length);
  dest.getRange(1,1,all.length,headers.length).setValues(all);

  dest.setFrozenRows(1);

  tmp.clearContents();

}



// Mover registros de eventos que ya existían en DATA, antes de separar

// definitivamente las dos pestañas. Evita perder histórico preexistente.

function etaMigrateSpecialExisting_(ss) {

  const data = etaParseRows_(ss.getSheetByName(OFSC_SYNC.DATA_SHEET));

  const special = data.filter(etaIsSpecial_);

  if (!special.length) return 0;

  const prev = etaParseRows_(ss.getSheetByName(ETA_INC.EVENTS_SHEET));

  const merged = ofscConsolidarEntreArboles_(prev.concat(special)).filter(etaIsSpecial_);

  etaWriteRows_(ss, ETA_INC.EVENTS_SHEET, etaCompleteParentAge_(merged));

  return special.length;

}



// Fecha del evento PADRE, derivada exclusivamente de EventoTableau.
// Ej.: 250911EN0000 -> 2025-09-11. El nombre de campo conserva días.
function etaParentAgeDays_(ticket, todayYmd) {
  var m=String(ticket||'').trim().match(/^(\d{2})(\d{2})(\d{2})[A-Z]/i);
  if(!m)return '';
  var year=2000+Number(m[1]), month=Number(m[2]), day=Number(m[3]);
  var date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return '';
  var t=String(todayYmd||etaYmd_(new Date())).split('-').map(Number);
  var today=Date.UTC(t[0],t[1]-1,t[2]);
  return Math.max(0,Math.round((today-date.getTime())/86400000));
}
function etaCompleteParentAge_(items) {
  var today=etaYmd_(new Date());
  return items.map(function(row){
    var copy=Object.assign({},row);
    copy.AntiguedadEventoPadreDias=etaParentAgeDays_(copy.EventoTableau,today);
    return copy;
  });
}
// Ejecutar manualmente UNA vez: completa la columna sobre hojas ya cargadas,
// sin consultar Oracle ni cambiar estado/selección de tickets.
function actualizarAntiguedadEventosPadre() {
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(5000))throw Error('Otra sincronización está en curso');
  try {
    var ss=getOfscSpreadsheet_(),output={};
    [OFSC_SYNC.DATA_SHEET,ETA_INC.EVENTS_SHEET].forEach(function(name){
      var sh=ss.getSheetByName(name);
      if(!sh||sh.getLastRow()<2){output[name]='SIN DATOS';return;}
      var lastRow=sh.getLastRow(),lastCol=sh.getLastColumn();
      var h=sh.getRange(1,1,1,lastCol).getValues()[0].map(String);
      var parentIdx=h.indexOf('EventoTableau');
      if(parentIdx<0){output[name]='SIN EventoTableau';return;}
      var targetIdx=h.indexOf('AntiguedadEventoPadreDias');
      if(targetIdx<0){targetIdx=lastCol;sh.getRange(1,targetIdx+1).setValue('AntiguedadEventoPadreDias');}
      var values=sh.getRange(2,parentIdx+1,lastRow-1,1).getValues();
      var today=etaYmd_(new Date());
      var result=values.map(function(row){return [etaParentAgeDays_(row[0],today)];});
      // Escribir únicamente la nueva columna, en bloques para reducir timeouts.
      for(var i=0;i<result.length;i+=1500){
        var block=result.slice(i,i+1500);
        sh.getRange(i+2,targetIdx+1,block.length,1).setValues(block);
      }
      output[name]={filas:result.length,columna:targetIdx+1};
    });
    console.log(JSON.stringify(output));return output;
  }finally{lock.releaseLock();}
}

function etaCommitWindow_(ss, sheetName, from, to, fresh, isEvents) {

  const old = etaParseRows_(ss.getSheetByName(sheetName));

  // Cuando una tarea cambia su FechaEfectiva se actualiza por Tarea.

  // La ventana actual se sustituye, incluso para retirar tareas que ya no

  // estén asignadas en las fechas consultadas.

  const freshIds = new Set(fresh.map(x => String(x.Tarea || x.apptNumber || '').trim().toUpperCase()));

  const keep = old.filter(x => {

    const id = String(x.Tarea || x.apptNumber || '').trim().toUpperCase();

    if (freshIds.has(id)) return false;

    const d = etaYmdCell_(x.FechaEfectiva);

    return !d || d < from || d > to;

  });

  const consolidated = ofscConsolidarEntreArboles_(keep.concat(fresh));

  // Por seguridad, los datos de eventos MP/ME/MF/MT jamás quedan en DATA.

  const filtered = consolidated.filter(x => isEvents ? etaIsSpecial_(x) : !etaIsSpecial_(x));

  filtered.sort((a,b) => String(b.FechaEfectiva||'').localeCompare(String(a.FechaEfectiva||'')) ||

    String(a.Tarea||'').localeCompare(String(b.Tarea||'')));

  etaWriteRows_(ss, sheetName, etaCompleteParentAge_(filtered));

  return {received:fresh.length, stored:filtered.length, preserved:keep.length};

}



// Ventanas operativas sin volver a consultar el histórico completo.
function etaWindow_(kind, props, today) {
  var back = kind === 'EVENTOS' ? ETA_INC.EVENTS_LOOKBACK_DAYS : ETA_INC.DATA_LOOKBACK_DAYS;
  return {from:etaPlus_(today,-back), to:etaPlus_(today,ETA_INC.OPERATIVE_FORWARD_DAYS), initial:false};
}

// Carga manual: últimos 30 días hasta HOY, jamás consulta fechas futuras.
// El avance se conserva por tipo en ScriptProperties, incluso si hay varios disparadores.
function cargarHistoricoData() { return etaSyncHistorico_('DATA'); }
function cargarHistoricoEventosMP() { return etaSyncHistorico_('EVENTOS'); }

// Opcional: cargar un intervalo histórico específico, editando estas dos fechas
// y ejecutando UNA vez la función correspondiente. No modifica triggers.
function cargarHistoricoDataRango() {
  return etaSyncHistorico_('DATA', '2026-09-14', '2026-10-14');
}
function cargarHistoricoEventosMPRango() {
  return etaSyncHistorico_('EVENTOS', '2026-09-14', '2026-10-14');
}

function etaSyncHistorico_(kind, customFrom, customTo) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { console.log('Otra sincronización en curso'); return {estado:'OMITIDA_LOCK'}; }
  try {
    var props = PropertiesService.getScriptProperties();
    var today = etaYmd_(new Date());
    var from = customFrom || etaPlus_(today,-ETA_INC.HISTORY_LOOKBACK_DAYS);
    var to = customTo || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to || to > today) {
      throw new Error('Rango histórico inválido; el fin no puede superar HOY.');
    }
    var key = 'ETA_HIST_'+kind+'_'+from+'_'+to;
    var cursor = props.getProperty(key) || from;
    if (cursor > to) return {estado:'COMPLETO', desde:from, hasta:to};
    var ss = getOfscSpreadsheet_();
    var events = kind === 'EVENTOS';
    var sheetName = events ? ETA_INC.EVENTS_SHEET : OFSC_SYNC.DATA_SHEET;
    var done = 0, last = '', stored=0;
    while (cursor <= to && done < ETA_INC.HISTORY_CHUNKS_PER_RUN) {
      var end = etaPlus_(cursor,ETA_INC.HISTORY_CHUNK_DAYS-1);
      if (end > to) end=to;
      var received = etaFetchTrees_(cursor,end);
      var selected = received.filter(x => events ? etaIsSpecial_(x) : !etaIsSpecial_(x));
      var cruce = ofscCruzarOracleTableau_(selected,ofscGetCacheTableau_());
      var result = etaCommitWindow_(ss,sheetName,cursor,end,cruce.items,events);
      stored = result.stored;
      last=end;
      cursor=etaPlus_(end,1);
      props.setProperty(key,cursor); // avanzar SOLO al publicar exitosamente
      done++;
    }
    var complete=cursor>to;
    console.log('HIST '+kind+' '+from+'..'+last+' '+(complete?'COMPLETO':'PENDIENTE'));
    return {estado:complete?'COMPLETO':'PENDIENTE',desde:from,procesadoHasta:last,proximoDesde:complete?'':cursor,hasta:to,registrosGuardados:stored};
  } finally {lock.releaseLock();}
}

function etaSyncIncremental_(kind) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { console.log('Otra sincronización en curso; no se ejecuta '+kind); return {estado:'OMITIDA_LOCK'}; }
  var now = new Date();
  var events=kind==='EVENTOS';
  var prefix=events?'eventos':'data';
  var sheetName=events?ETA_INC.EVENTS_SHEET:OFSC_SYNC.DATA_SHEET;
  try {
    var ss=getOfscSpreadsheet_();
    var window=etaWindow_(kind,PropertiesService.getScriptProperties(),etaYmd_(now));
    // Primero bajar ocho árboles y validar TODO; luego publicar.
    var received=etaFetchTrees_(window.from,window.to);
    var selected=received.filter(x=>events?etaIsSpecial_(x):!etaIsSpecial_(x));
    var cruce=ofscCruzarOracleTableau_(selected,ofscGetCacheTableau_());
    var result=etaCommitWindow_(ss,sheetName,window.from,window.to,cruce.items,events);
    var finish=new Date();
    var control={};
    control[prefix+'Estado']='OK';
    control[prefix+'UltimaActualizacionExitosa']=finish;
    control[prefix+'Desde']=window.from;
    control[prefix+'Hasta']=window.to;
    control[prefix+'RegistrosRecibidos']=result.received;
    control[prefix+'RegistrosGuardados']=result.stored;
    if(!events) {
      control.estado='OK'; control.ultimoIntento=now;
      control.ultimaActualizacionExitosa=finish;
      control.desde=window.from; control.hasta=window.to;
      control.registros=result.stored;
      control.arboles=OFSC_SYNC.TREES.join(', ');
      control.origen=OFSC_SYNC.WORKER_BASE_URL+'/api/final_range';
      control.duracionSegundos=Math.round((finish-now)/100)/10;
    }
    // CONTROL es informativo: si falla después de publicar, no se marca como fallo de sincronización.
    try { etaUpdateControlLigero_(ss,control); }
    catch(e) { console.warn('Se publicaron los datos; CONTROL pendiente: '+e); }
    console.log(prefix+' '+JSON.stringify({desde:window.from,hasta:window.to,recibidos:result.received,guardados:result.stored}));
    return control;
  } catch(err) {
    console.error('ERROR '+kind+': '+String(err&&err.message||err));
    try { etaUpdateControlLigero_(getOfscSpreadsheet_(),{[prefix+'Estado']:'ERROR',[prefix+'UltimoError']:String(err&&err.message||err)}); }
    catch(e) {console.warn('No se pudo actualizar CONTROL: '+e);}
    throw err;
  } finally { lock.releaseLock(); }
}

// Una sola lectura/escritura de CONTROL sin limpiar ni reformatear la hoja.
function etaUpdateControlLigero_(ss, values) {
  var sh=ss.getSheetByName(OFSC_SYNC.CONTROL_SHEET);
  if(!sh) sh=ss.insertSheet(OFSC_SYNC.CONTROL_SHEET);
  var last=sh.getLastRow();
  var rows=last?sh.getRange(1,1,last,2).getValues():[];
  var index={};
  rows.forEach(function(row,i){if(row[0])index[String(row[0])]=i;});
  Object.keys(values).forEach(function(k){
    if(Object.prototype.hasOwnProperty.call(index,k)) rows[index[k]][1]=values[k];
    else {index[k]=rows.length;rows.push([k,values[k]]);}
  });
  if(rows.length) sh.getRange(1,1,rows.length,2).setValues(rows);
}


/** Ejecutar UNA vez si la hoja actual ya contiene fechas en columnas contador.
 * No consulta Oracle ni borra filas; hace una copia de seguridad antes de ejecutar.
 */
function repararFormatoContadoresETA() {
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(5000)) throw new Error('Hay una sincronización en curso');
  try {
    var ss=getOfscSpreadsheet_(), result={};
    [OFSC_SYNC.DATA_SHEET,ETA_INC.EVENTS_SHEET].forEach(function(sheetName){
      var sh=ss.getSheetByName(sheetName);
      if(!sh || sh.getLastRow()<2){result[sheetName]='SIN DATOS';return;}
      var h=sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(String);
      var summary={};
      ['TotalAsignaciones','VecesSuspendida'].forEach(function(name){
        var ix=h.indexOf(name); if(ix<0){summary[name]='SIN COLUMNA';return;}
        var range=sh.getRange(2,ix+1,sh.getLastRow()-1,1);
        var original=range.getValues();
        var invalid=0, converted=0;
        var values=original.map(function(row){
          var v=row[0], n=etaCounterValue_(v);
          if(n !== '' && (typeof n!=='number' || !Number.isInteger(n) || n<0)) invalid++;
          if(v instanceof Date || (typeof v==='string' && /^(?:18|19)\d{2}-/.test(v))) converted++;
          return [n];
        });
        if(invalid) throw new Error('Valores no convertibles en '+sheetName+'.'+name+': '+invalid);
        range.setNumberFormat('0');
        for(var i=0;i<values.length;i+=1000)range.offset(i,0,Math.min(1000,values.length-i),1).setValues(values.slice(i,i+1000));
        summary[name]={filas:values.length,fechasRecuperadas:converted};
      });
      result[sheetName]=summary;
    });
    console.log(JSON.stringify(result));return result;
  } finally {lock.releaseLock();}
}

