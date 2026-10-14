/* ETA visual preferences v23.0. Design-only: no API calls, no data changes. */
(() => {
  'use strict';
  const STORE='eta_visual_preferences_v1';
  const $=s=>document.querySelector(s);
  const THEMES=[['original','Original','Tema actual, predeterminado'],['sky','Sky','Claro y luminoso'],['noche','Noche','Modo oscuro'],['retro','Retro','Inspiración Windows 95'],['clasico','Clásico','Herramienta profesional'],['compacto','Compacto','Máxima densidad']];
  const FIELDS=[['created','Creado (antigüedad)'],['parent','Antigüedad evento padre'],['suspended','Estado suspendida'],['infra','Infra'],['fibra','Fibra']];
  const PALETTES={
    balanceado:{created:'#FFEB9C',parent:'#FFC7CE',suspended:'#F4A3A8',infra:'#FFC2CA',fibra:'#FFE69A'},
    suave:{created:'#FFF2D4',parent:'#F6DADE',suspended:'#EAC6C8',infra:'#F5DFE4',fibra:'#FFF0CB'},
    contraste:{created:'#FFDA70',parent:'#F7A0A9',suspended:'#DC8189',infra:'#EEAFBE',fibra:'#F9CF64'},
    criticos:{created:'#FFCB65',parent:'#F49A88',suspended:'#D77678',infra:'#F0A19A',fibra:'#FFD769'}
  };
  const DEFAULT={theme:'original',palette:'balanceado',colors:{...PALETTES.balanceado},muted:false,chips:true,kpis:true,legend:true,dense:false};
  const clone=x=>JSON.parse(JSON.stringify(x));
  const isHex=x=>/^#[a-fA-F0-9]{6}$/.test(x||'');
  function normalize(src){const x=clone(DEFAULT);if(!src||typeof src!=='object')return x;
    if(THEMES.some(y=>y[0]===src.theme))x.theme=src.theme;
    if(PALETTES[src.palette])x.palette=src.palette;
    for(const [k] of FIELDS) if(isHex(src.colors?.[k]))x.colors[k]=src.colors[k].toUpperCase();
    for(const k of ['muted','chips','kpis','legend','dense'])if(typeof src[k]==='boolean')x[k]=src[k];return x;}
  let saved;try{saved=normalize(JSON.parse(localStorage.getItem(STORE)||'null'));}catch{saved=clone(DEFAULT);}
  let draft=clone(saved);
  const panel=$('#etaVisualPanel'),back=$('#etaVisualBackdrop');
  const titleEscape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function addAlpha(hex,a){const n=parseInt(hex.slice(1),16);return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;}
  function apply(x){
    const root=document.documentElement;
    root.dataset.etaTheme=x.theme;
    root.dataset.etaPalette=x.palette;
    root.classList.toggle('eta-visual-muted',x.muted);
    root.classList.toggle('eta-visual-nochips',!x.chips);
    root.classList.toggle('eta-visual-nokpis',!x.kpis);
    root.classList.toggle('eta-visual-dense',x.dense||x.theme==='compacto');
    // Original + Balanceado retains the original exact age and KPI rules until customized.
    const custom=x.palette!=='balanceado'||FIELDS.some(([k])=>x.colors[k].toUpperCase()!==PALETTES.balanceado[k]);
    root.classList.toggle('eta-visual-custom',custom);
    for(const [k] of FIELDS){root.style.setProperty(`--eta-${k}`,x.colors[k]);root.style.setProperty(`--eta-${k}-soft`,addAlpha(x.colors[k],0.48));}
    root.style.setProperty('--eta-created-green',x.theme==='noche'?'#164A46':'#C6EFCE');
  }
  function open(){draft=clone(saved);draw();panel.classList.add('open');panel.setAttribute('aria-hidden','false');back.classList.remove('hidden');document.getElementById('sideMenu')?.classList.remove('open');document.getElementById('sideBackdrop')?.classList.add('hidden');document.getElementById('sideMenu')?.setAttribute('aria-hidden','true');document.getElementById('btnMenu')?.setAttribute('aria-expanded','false');}
  function close(){panel.classList.remove('open');panel.setAttribute('aria-hidden','true');back.classList.add('hidden');apply(saved);}
  function draw(){
    $('#etaVisualThemes').innerHTML=THEMES.map(([id,name,desc])=>`<button type="button" class="eta-theme-card ${draft.theme===id?'selected':''}" data-eta-theme="${id}" aria-pressed="${draft.theme===id}"><span class="eta-theme-mini" data-mini="${id}"><i></i><i></i><i></i></span><b>${name}</b><small>${desc}</small>${id==='original'?'<em>Predeterminado</em>':''}</button>`).join('');
    $('#etaVisualColors').innerHTML=FIELDS.map(([id,name])=>`<label class="eta-color-row"><span class="eta-swatch" style="background:${draft.colors[id]}"></span><span>${name}</span><input type="color" data-eta-color="${id}" value="${draft.colors[id]}" aria-label="Color de ${name}"><code>${draft.colors[id]}</code></label>`).join('');
    $('#etaVisualPalettes').innerHTML=[['balanceado','Balanceado'],['suave','Suave'],['contraste','Contraste medio'],['criticos','Datos críticos']].map(([id,name])=>`<button type="button" data-eta-palette="${id}" class="eta-palette-card ${draft.palette===id?'selected':''}" aria-pressed="${draft.palette===id}"><span>${Object.values(PALETTES[id]).slice(0,4).map(v=>`<i style="background:${v}"></i>`).join('')}</span><b>${name}</b></button>`).join('');
    for(const [id,key] of [['etaOptMuted','muted'],['etaOptChips','chips'],['etaOptKpis','kpis'],['etaOptLegend','legend'],['etaOptDense','dense']])$('#'+id).checked=draft[key];
    $('#etaVisualLegend').hidden=!draft.legend;
    $('#etaVisualLegend').innerHTML=[['Creado',draft.colors.created],['Evento padre',draft.colors.parent],['Suspendida',draft.colors.suspended],['Infra',draft.colors.infra],['Fibra',draft.colors.fibra],['1 día','#C6EFCE'],['Edificio','#D9EAFA'],['Red + Energía','#D8EFD0']].map(([k,c])=>`<div><i style="background:${c}"></i>${titleEscape(k)}</div>`).join('');
    $('#etaVisualPreview').innerHTML=`<div class="eta-preview-head"><span>Tarea</span><span>Creado</span><span>Estado</span><span>Subcapa</span><span>Antigüedad</span></div><div class="eta-preview-row"><span>TAREA001</span><span style="background:${draft.colors.created}">12/10/26</span><span>INICIADA</span><span style="background:${draft.colors.fibra}">Fibra</span><span>2</span></div><div class="eta-preview-row"><span>TAREA002</span><span>12/10/26</span><span style="background:${draft.colors.suspended}">SUSPENDIDA</span><span style="background:${draft.colors.infra}">Infra</span><span style="background:${draft.colors.parent}">5</span></div>`;
  }
  $('#btnVisualOptions')?.addEventListener('click',open);
  $('#etaVisualClose')?.addEventListener('click',close);back?.addEventListener('click',close);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&panel.classList.contains('open'))close();});
  $('#etaVisualThemes').addEventListener('click',e=>{const b=e.target.closest('[data-eta-theme]');if(b){draft.theme=b.dataset.etaTheme;apply(draft);draw();}});
  $('#etaVisualPalettes').addEventListener('click',e=>{const b=e.target.closest('[data-eta-palette]');if(b){draft.palette=b.dataset.etaPalette;draft.colors={...PALETTES[draft.palette]};apply(draft);draw();}});
  $('#etaVisualColors').addEventListener('input',e=>{const id=e.target.dataset.etaColor;if(id&&isHex(e.target.value)){draft.colors[id]=e.target.value.toUpperCase();apply(draft);e.target.parentElement.querySelector('code').textContent=draft.colors[id];e.target.parentElement.querySelector('.eta-swatch').style.background=draft.colors[id];$('#etaVisualPalettes').querySelectorAll('button').forEach(b=>b.classList.remove('selected'));draft.palette='personalizada';}});
  for(const [id,key] of [['etaOptMuted','muted'],['etaOptChips','chips'],['etaOptKpis','kpis'],['etaOptLegend','legend'],['etaOptDense','dense']])$('#'+id).addEventListener('change',e=>{draft[key]=e.target.checked;apply(draft);draw();});
  $('#etaVisualApply').addEventListener('click',()=>{saved=normalize(draft);try{localStorage.setItem(STORE,JSON.stringify(saved));}catch{}apply(saved);close();});
  $('#etaVisualReset').addEventListener('click',()=>{draft=clone(DEFAULT);apply(draft);draw();});
  apply(saved);
})();
