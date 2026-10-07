import {createMobileApp} from './app-ui.mjs';
import {createApi} from './api.mjs';
import {createDemoApi} from './demo-api.mjs';
const query=new URLSearchParams(location.search);
const demo=query.get('demo')==='1'||document.querySelector('meta[name="book-preview"]');
const api=demo?createDemoApi({storage:localStorage}):createApi();
const app=createMobileApp({root:document.querySelector('#app'),api});
window.addEventListener('pagehide',()=>app.dispose(),{once:true});
