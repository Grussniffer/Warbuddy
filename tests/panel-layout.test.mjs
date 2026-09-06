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
    assert.ok(style.indexOf('height:auto !important')>style.indexOf('@media (max-width:520px)'));
    assert.match(style,/min-block-size:0 !important/);
    assert.match(style,/flex-grow:0 !important/);
    assert.match(style,/wc-roster-mode > \.wc-body \{ max-height:min\(60vh,520px\) !important; max-height:min\(60dvh,520px\) !important; overflow-y:auto !important/);
});

const browser=process.env.WARBUDDY_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
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
