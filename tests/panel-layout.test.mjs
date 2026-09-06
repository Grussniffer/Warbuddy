import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,writeFileSync,mkdtempSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const source=readFileSync(new URL('../src/userscript.js',import.meta.url),'utf8');
const style=source.slice(source.indexOf('addStyle(`')+10,source.indexOf('const normalizeResponse')).split('`);')[0];
test('panel size guards follow responsive rules and bound only scrollable contents',()=>{
    assert.ok(style.indexOf('height:fit-content !important')>style.indexOf('@media (max-width:520px)'));
    const guards=style.slice(style.indexOf('/* Bound our own content'));
    assert.doesNotMatch(guards,/flex-grow|flex-basis|align-self|block-size/);
    assert.match(style,/wc-roster-mode > \.wc-body \{ max-height:min\(60vh,520px\) !important; max-height:min\(60dvh,520px\) !important; overflow-y:auto !important/);
});

const browser=process.env.WARBUDDY_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
test('real browser: fallback never compresses native siblings during ranked-war loading',{skip:!existsSync(browser)},()=>{
    const dir=mkdtempSync(join(tmpdir(),'warbuddy-mount-'));
    const css=style.replace(/\$\{([A-Z_]+)\}/g,(_,name)=>name.toLowerCase());
    const mountSource=source.slice(source.indexOf('  function rankedWarRosterContextMountPoint()'),source.indexOf('  function positionNativeOverlay('));
    const html=`<!doctype html><style>body{margin:0}#mainContainer{width:800px}.native{flex:1;min-width:0}.heading{display:flex}.heading span{flex:1;min-width:0}.native p{margin:0}${css}</style>
      <main id="mainContainer"></main><pre id="result"></pre><script>
      const main=document.querySelector('main'),SAFE_INTEGRATED_PARENT_DISPLAYS=new Set(['block','flow-root','list-item']),ROSTER_CONTEXT_ID='roster_context_id',PANEL_ID='panel_id';
      const core={isOwnRankedWarPageUrl:()=>true},state={session:{factionId:'1'}};
      const rankedWarFilterBar=()=>null,rankedWarMainContent=()=>main;
      ${mountSource}
      const results=[];
      function addPanel(parent){const panel=document.createElement('details');panel.id='roster_context_id';panel.className='wc-native-roster-context';panel.open=true;panel.innerHTML='<summary>Warbuddy</summary><div id="integrated_host_id"><div id="panel_id" class="wc-integrated-inline wc-roster-mode wc-inline-accordion"><div class="wc-body">Action queue</div></div></div>';parent.appendChild(panel);return panel;}
      for(const display of ['flex','grid','table','block']){
        main.style.display=display;main.innerHTML='<div class="native"><div class="heading"><span>YOUR FACTION IS IN A WAR</span><span>RANK PLATINUM</span><span>RESPECT 2,830,496</span></div><p>Chain and war score</p></div>';
        const native=main.firstElementChild,before=native.getBoundingClientRect().width;
        const mount=rankedWarRosterContextMountPoint();if(mount)addPanel(mount.parent);
        const after=native.getBoundingClientRect().width;
        let previousWidth=null;
        if(display==='flex'){const old=addPanel(main);previousWidth=native.getBoundingClientRect().width;old.remove();}
        results.push({display,before,after,mounted:!!mount,previousWidth});
      }
      main.style.display='block';main.innerHTML='<div class="native">Rank and war scores</div><div class="faction-war"><div data-ff-filter-box>FF Scouter controls</div><div class="enemy-faction">Enemy</div><div class="your-faction">Allies</div></div>';
      const war=main.querySelector('.faction-war'),filter=war.firstChild,enemy=war.querySelector('.enemy-faction'),ally=war.querySelector('.your-faction');
      const nativeWidth=main.firstChild.getBoundingClientRect().width;
      const mount=rankedWarRosterContextMountPoint();const mountedPanel=addPanel(mount.parent);mount.parent.insertBefore(mountedPanel,mount.before);
      const again=rankedWarRosterContextMountPoint();
      results.push({nativeAnchor:mount.parent===war,filterIntact:filter.parentNode===war,listsIntact:enemy.parentNode===war&&ally.parentNode===war,stable:again.parent===war&&again.before===mountedPanel.nextSibling,widthIntact:main.firstChild.getBoundingClientRect().width===nativeWidth});
      document.querySelector('#result').textContent=JSON.stringify(results);
      </script>`;
    const fixture=join(dir,'mount.html');writeFileSync(fixture,html);
    const run=spawnSync(browser,['--headless','--disable-gpu','--no-first-run',`--user-data-dir=${join(dir,'profile')}`,'--window-size=1073,782','--dump-dom',pathToFileURL(fixture).href],{encoding:'utf8',timeout:25000,windowsHide:true,maxBuffer:2*1024*1024});
    assert.equal(run.status,0,run.error?.message || run.stderr);
    const results=JSON.parse(run.stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1] || '[]');
    assert.equal(results.length,5);
    assert.deepEqual(results[4],{nativeAnchor:true,filterIntact:true,listsIntact:true,stable:true,widthIntact:true});
    for(const result of results.slice(0,4)){
        assert.equal(result.after,result.before,`${result.display}: native content width must not change`);
        assert.equal(result.mounted,result.display==='block',`${result.display}: only block fallback is safe`);
        if(result.display==='flex')assert.ok(result.previousWidth<result.before/2,'old unguarded fallback reproduces native compression');
    }
});
test('real browser: short contents shrink, long contents scroll, collapsed header remains compact',{skip:!existsSync(browser)},()=>{
    const dir=mkdtempSync(join(tmpdir(),'warbuddy-layout-'));
    const css=style.replace(/\$\{([A-Z_]+)\}/g,(_,name)=>name.toLowerCase());
    const html=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      body{margin:0}.host{display:grid;min-height:2000px;width:100%}
      #roster_context_id,#integrated_host_id,#panel_id,.wc-body{height:1800px;min-height:1400px;flex:1}
      ${css}
    </style><div class="host"><details id="roster_context_id" class="wc-native-roster-context" open><summary>Warbuddy</summary><div id="integrated_host_id" class="wc-native-roster-panel-host"><div id="panel_id" class="wc-integrated-inline wc-roster-mode wc-inline-accordion"><div class="wc-body"><div id="contents" style="height:90px">Short content</div></div></div></div></details></div><pre id="result"></pre><script>
      const root=document.querySelector('details'),body=document.querySelector('.wc-body'),contents=document.querySelector('#contents');
      const short=root.getBoundingClientRect().height;
      contents.style.height='2400px';
      const long=root.getBoundingClientRect().height,bodyHeight=body.getBoundingClientRect().height;
      body.scrollTop=400;const scroll=body.scrollTop;
      root.open=false;const collapsed=root.getBoundingClientRect().height;
      document.querySelector('#result').textContent=JSON.stringify({short,long,bodyHeight,scroll,collapsed,viewport:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth});
    </script>`;
    const fixture=join(dir,'layout.html');writeFileSync(fixture,html);
    for(const size of ['1073,782','390,650','900,450']) {
      const run=spawnSync(browser,['--headless','--disable-gpu','--no-first-run',`--user-data-dir=${join(dir,size.replace(',','-'))}`,`--window-size=${size}`,'--dump-dom',pathToFileURL(fixture).href],{encoding:'utf8',timeout:25000,windowsHide:true,maxBuffer:2*1024*1024});
      assert.equal(run.status,0,run.error?.message || run.stderr);
      const result=JSON.parse(run.stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1] || '{}');
      assert.ok(result.short<180,`${size}: unexpected empty space ${JSON.stringify(result)}`);
      assert.ok(result.bodyHeight<=Math.min(result.viewport*.6,520)+1,`${size}: body exceeds viewport cap`);
      assert.ok(result.scroll>0,`${size}: full list must remain scrollable`);
      assert.ok(result.collapsed<80,`${size}: collapsed accordion must shrink`);
      assert.equal(result.overflow,false,`${size}: horizontal overflow`);
    }
});
