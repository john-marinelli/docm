import {spawn} from 'node:child_process';

const [command,...args]=process.argv.slice(2);
if(!command)throw new Error('A command is required');
// Keep Chromium sandboxing enabled; a virtual display is not a sandbox bypass.
const child=process.platform==='linux'
  ?spawn('xvfb-run',['-a',command,...args],{stdio:'inherit',env:process.env})
  :spawn(command,args,{stdio:'inherit',env:process.env});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});
child.once('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exitCode=code??1;});
