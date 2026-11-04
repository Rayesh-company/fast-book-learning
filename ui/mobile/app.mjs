import {createMobileApp} from './app-ui.mjs';
import {createApi} from './api.mjs';
import {createDemoApi} from './demo-api.mjs';
import {registerServiceWorker} from './pwa.mjs';
registerServiceWorker(window);
const query=new URLSearchParams(location.search);
const demo=query.get('demo')==='1'||query.get('view')==='admin'||document.querySelector('meta[name="book-preview"]');
const api=demo?createDemoApi({storage:localStorage}):createApi();
// The برنامک's own query (ADR-0021): Eitaa's WebView signs the open
// with initData riding the root (fahva/?initData=…); the app exchanges
// it for the bound Account's session at boot — demo never carries one.
const app=createMobileApp({root:document.querySelector('#app'),api,initData:demo?null:query.get('initData')});
window.addEventListener('pagehide',()=>app.dispose(),{once:true});
