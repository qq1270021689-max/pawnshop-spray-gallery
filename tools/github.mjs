import {readFileSync} from 'node:fs';
import {validateSubmission,applySubmission} from './library.mjs';

const repository=process.env.GITHUB_REPOSITORY,token=process.env.GITHUB_TOKEN;
if(!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository??''))throw Error('仓库标识无效');
const api=async(route,method='GET',data)=> {
  if(!route.startsWith('/repos/'))throw Error('只允许仓库接口');
  const response=await fetch('https://api.github.com'+route,{method,redirect:'error',signal:AbortSignal.timeout(30000),
    headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',Authorization:`Bearer ${token}`,...(data?{'Content-Type':'application/json'}:{})},
    body:data?JSON.stringify(data):undefined});
  let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.length;if(size>18*1024*1024)throw Error('GitHub响应过大');chunks.push(chunk);}
  if(!response.ok)throw Error(`GitHub请求失败 ${response.status} ${route.split('/').slice(-2).join('/')}`);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};
const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
const number=event.pull_request?.number??Number(event.inputs?.pull_request_number);
if(!Number.isSafeInteger(number)||number<1)throw Error('需要投稿PR编号');
const pr=await api(`/repos/${repository}/pulls/${number}`);
if(pr.base.repo.full_name!==repository||pr.base.ref!=='main')throw Error('投稿目标必须是本库main分支');
const changes=await api(`/repos/${repository}/pulls/${number}/files?per_page=100`);
if(pr.changed_files!==1||changes.length!==1||changes[0].status!=='added'||!/^submissions\/[a-f0-9]{32}\.json$/.test(changes[0].filename))throw Error('每次投稿只能新增一个submissions图案文件，不能改其他文件');
const file=changes[0];if(!/^[a-f0-9]{40}$/.test(file.sha))throw Error('投稿文件版本无效');
const headRepo=pr.merged?repository:pr.head.repo?.full_name;
if(!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(headRepo??''))throw Error('投稿来源仓库无效');
const blob=await api(`/repos/${headRepo}/git/blobs/${file.sha}`);
if(blob.encoding!=='base64'||blob.size>12*1024*1024)throw Error('投稿文件超过大小限制');
const bytes=Buffer.from(blob.content,'base64');if(bytes.length!==blob.size)throw Error('投稿文件不完整');
const submission=validateSubmission(JSON.parse(bytes.toString('utf8')),file.filename);
const mode=process.argv[2];if(!['validate','publish'].includes(mode))throw Error('操作无效');
if(mode==='publish'&&!pr.merged)throw Error('只有审核合并后的投稿可以上架');
for(let attempt=0;attempt<5;attempt++) {
  const ref=await api(`/repos/${repository}/git/ref/heads/main`),parent=ref.object.sha;
  const baseCommit=await api(`/repos/${repository}/git/commits/${parent}`);
  const index=await api(`/repos/${repository}/contents/catalog.json?ref=${parent}`);
  if(index.encoding!=='base64'||index.size>1024*1024)throw Error('作品目录无法读取');
  const original=JSON.parse(Buffer.from(index.content,'base64').toString('utf8'));
  const result=applySubmission(original,submission,pr.user,repository.split('/')[0],pr.merged_at??new Date().toISOString());
  if(mode==='validate'){console.log(`投稿校验通过：${submission.operation} / ${submission.id} / @${pr.user.login}`);break;}
  const entries=[];
  for(const asset of result.files) {
    if(asset.remove)entries.push({path:asset.path,mode:'100644',type:'blob',sha:null});
    else {
      const uploaded=await api(`/repos/${repository}/git/blobs`,'POST',{encoding:'base64',content:asset.bytes.toString('base64')});
      entries.push({path:asset.path,mode:'100644',type:'blob',sha:uploaded.sha});
    }
  }
  // The source submission stays in Git history; remove it from the live tree after processing.
  const live=await api(`/repos/${repository}/git/trees/${baseCommit.tree.sha}?recursive=1`);
  if(live.truncated)throw Error('作品库树过大，需要维护者分库');
  if(live.tree.some(e=>e.path===file.filename))entries.push({path:file.filename,mode:'100644',type:'blob',sha:null});
  if(!result.files.length&&!entries.length){console.log('该投稿已处理，无需重复写入');break;}
  entries.push({path:'catalog.json',mode:'100644',type:'blob',content:JSON.stringify(result.catalog,null,2)+'\n'});
  const tree=await api(`/repos/${repository}/git/trees`,'POST',{base_tree:baseCommit.tree.sha,tree:entries});
  const commit=await api(`/repos/${repository}/git/commits`,'POST',{message:`Process artwork submission #${number} (${submission.operation})`,tree:tree.sha,parents:[parent]});
  try {
    await api(`/repos/${repository}/git/refs/heads/main`,'PATCH',{sha:commit.sha,force:false});
    console.log(`已处理投稿 #${number}：${submission.id}，提交 ${commit.sha}`);break;
  }catch(error){if(attempt===4)throw error;}
}
