// Use WorkBuddy's native storage capability and its shipped credential bootstrap protocol.
// Secret material remains in memory and is sent only to this wrapper's own child over a named pipe.
const fs=require('node:fs');const path=require('node:path');const net=require('node:net');const crypto=require('node:crypto');const {spawn}=require('node:child_process');
const id=process.argv[2];if(!['workbuddy-a','workbuddy-ai-b'].includes(id))throw Error('Unknown WorkBuddy target');
const install=id==='workbuddy-a'?'D:/workbuddy':'D:/workbuddy ai/WorkBuddyAI';
const profile=process.env.DSH_WORKBUDDY_PROFILE_DIR||path.join(process.env.USERPROFILE,'.dsh','harness-accounts',id);
const api=require(path.join(install,'resources/app.asar/main/process-cpu-sampler.js'));api.$();
const native=process._linkedBinding('electron_browser_workbuddy_storage');
const capabilities=api._t(native.loggerGet());
if(capabilities.symmetric.status!=='available')throw Error('Native credential protection capability unavailable');
const keyblob=api.nt({keyblobPath:process.env.DSH_WORKBUDDY_KEYBLOB_PATH||api.tt(id==='workbuddy-a'?'C:/Users/Administrator/.workbuddy':'C:/Users/Administrator/.workbuddy-ai'),protectorKey:capabilities.symmetric.value,createIfMissing:false});
if(keyblob.status!=='available'||capabilities.developerPublicKey.status!=='available')throw Error('Native asymmetric credential protection capability unavailable');
const bootstrap={policy:'fields',symmetricKey:capabilities.symmetric.value,userKey:keyblob.value,developerPublicKey:capabilities.developerPublicKey.value};
const serialized=api.Z(bootstrap);
const nonce=crypto.randomBytes(16).toString('hex');const token=crypto.randomBytes(32).toString('hex');
const readyPipe=`\\\\.\\pipe\\dsh-wb-ready-${nonce}`;const credentialPipe=`\\\\.\\pipe\\dsh-wb-credential-${nonce}`;
let child;let stopping=false;let attempts=0;let retry;
const readyServer=net.createServer(socket=>{let buf='';socket.on('data',data=>{buf+=data;const i=buf.indexOf('\n');if(i<0)return;try{const v=JSON.parse(buf.slice(0,i));if(v.method!=='session.ready'||v.params?.token!==token||v.params?.pid!==child?.pid){socket.destroy();return;}socket.end(JSON.stringify({jsonrpc:'2.0',id:v.id,result:{ok:true}})+'\n');}catch{socket.destroy();}});});
const env={...process.env,CODEBUDDY_CONFIG_DIR:profile,WORKBUDDY_CONFIG_DIR:profile,WORKBUDDY_AT_REST_ENCRYPTION:'fields',CODEBUDDY_SIDECAR_READY_SOCKET:readyPipe,CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET:credentialPipe,CODEBUDDY_SIDECAR_READY_TOKEN:token,CODEBUDDY_SIDECAR_READY_SESSION_ID:nonce};
for(const key of ['ELECTRON_RUN_AS_NODE','CODEBUDDY_AUTH_TOKEN','CODEBUDDY_API_KEY','CODEBUDDY_BASE_URL','CODEBUDDY_CREDENTIALS_IN_MEMORY','CODEBUDDY_INTERNET_ENVIRONMENT','CODEBUDDY_INTERNET_ENVIROMENT'])delete env[key];
if(id==='workbuddy-a')env.CODEBUDDY_INTERNET_ENVIRONMENT='internal';
function stop(){if(stopping)return;stopping=true;clearTimeout(retry);readyServer.close();child?.kill();try{api.X(bootstrap);}catch{}}
readyServer.listen(readyPipe,()=>{child=spawn('C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe',[path.join(install,'resources/app.asar.unpacked/cli/bin/codebuddy'),...process.argv.slice(3)],{env,cwd:process.cwd(),windowsHide:true,stdio:['pipe','pipe','pipe']});process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.on('error',e=>{console.error(e.message);stop();process.exitCode=1;});child.on('close',code=>{stop();process.exitCode=code??1;});connectBootstrap();});
function connectBootstrap(){if(stopping)return;if(++attempts>500){console.error('Credential bootstrap listener timeout');stop();process.exitCode=1;return;}const socket=net.createConnection(credentialPipe);let ack='';let connected=false;socket.once('connect',()=>{connected=true;socket.write(JSON.stringify({version:1,pid:child.pid,sessionId:nonce,token,bootstrap:serialized})+'\n');});socket.on('data',data=>{ack+=data;const i=ack.indexOf('\n');if(i<0)return;try{const v=JSON.parse(ack.slice(0,i));if(v.ok!==true||v.policy!=='fields')throw Error('Credential bootstrap rejected');socket.end();console.error('[managed-wrapper] credential bootstrap acknowledged');}catch(e){console.error(e.message);stop();process.exitCode=1;}});socket.once('error',()=>{socket.destroy();if(!connected)retry=setTimeout(connectBootstrap,20);else{console.error('Credential bootstrap transport failed');stop();process.exitCode=1;}});}
process.on('SIGINT',()=>{stop();process.exitCode=130;});process.on('SIGTERM',()=>{stop();process.exitCode=143;});
process.stdin.on('end',()=>{if(process.argv.includes('--acp')){const timer=setTimeout(()=>{stop();},1500);timer.unref();}});
