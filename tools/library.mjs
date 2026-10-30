import {createHash} from 'node:crypto';
import {normalizePng} from './png.mjs';

const idPattern=/^[a-f0-9]{32}$/;
const categories=new Set(['wall','counter','tattoo','portrait','phone']);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const required=(condition,message)=>{if(!condition)throw Error(message);};
export function validateSubmission(value,filename) {
  required(value&&value.version===1&&idPattern.test(value.id??''),'投稿版本或作品编号无效');
  required(/^submissions\/[a-f0-9]{32}\.json$/.test(filename),'只接受submissions中的投稿JSON');
  required(['publish','remove'].includes(value.operation),'投稿操作不支持');
  const allowed=value.operation==='publish'?['version','operation','id','title','category','profile','png']:['version','operation','id'];
  required(Object.keys(value).every(k=>allowed.includes(k)),'投稿中包含不支持的字段');
  if(value.operation==='remove')return {operation:'remove',id:value.id};
  required(filename===`submissions/${value.id}.json`,'投稿文件名与作品编号不一致');
  required(typeof value.title==='string'&&value.title.trim().length>0&&value.title.length<=60&&!/[\u0000-\u001f]/u.test(value.title),'作品标题无效');
  required(categories.has(value.category)&&typeof value.profile==='string'&&value.profile.length<=180,'作品分类或画布无效');
  const profile=value.category==='tattoo'?/^spray-(?:back-v1\/(?:sia|eleanor)|commission-back-v1\/[0-3])$/.test(value.profile):
    value.category==='portrait'?value.profile.startsWith('portrait/')&&value.profile.length>9:value.profile===value.category;
  required(profile,'作品不适用于该画布');
  required(typeof value.png==='string'&&value.png.length<=8*1024*1024*4/3+4&&value.png.length%4===0&&!/[^A-Za-z0-9+/=]/.test(value.png),'图案编码无效或超过8MB');
  const bytes=Buffer.from(value.png,'base64');required(bytes.toString('base64')===value.png,'图案编码无效');
  return {operation:'publish',id:value.id,title:value.title.trim(),category:value.category,profile:value.profile,...normalizePng(bytes)};
}
export function applySubmission(original,submission,actor,owner,createdAt=new Date().toISOString()) {
  required(original?.version===1&&Array.isArray(original.works)&&Array.isArray(original.removed??[]),'作品目录损坏或版本不支持');
  required(typeof actor?.login==='string'&&/^[A-Za-z0-9-]{1,39}$/.test(actor.login)&&Number.isSafeInteger(actor.id)&&actor.id>0,'投稿者GitHub身份无效');
  const catalog=structuredClone(original);catalog.removed??=[];const files=[];
  const old=catalog.works.find(w=>w.id===submission.id);
  if(submission.operation==='remove') {
    if(!old) {
      const tombstone=catalog.removed.find(w=>w.id===submission.id);
      required(tombstone&&(tombstone.githubUserId===actor.id||actor.login.toLowerCase()===owner.toLowerCase()),'作品不存在或无权下架');
      return {catalog,files};
    }
    required(old.githubUserId===actor.id||actor.login.toLowerCase()===owner.toLowerCase(),'只能由原投稿账号或仓库维护者申请下架');
    catalog.works=catalog.works.filter(w=>w.id!==old.id);
    catalog.removed.push({id:old.id,githubUserId:old.githubUserId,removedAt:createdAt});
    files.push({path:`works/${old.id}/image.png`,remove:true},{path:`works/${old.id}/thumbnail.png`,remove:true});
  } else {
    required(!catalog.removed.some(w=>w.id===submission.id),'该编号已经下架，请重新打开分享页生成新投稿');
    const imageHash=hash(submission.png);
    if(old) {
      required(old.githubUserId===actor.id&&old.hash===imageHash&&old.title===submission.title&&old.category===submission.category&&old.profile===submission.profile,'作品编号重复或已由其他作者使用');
      return {catalog,files};
    }
    required(catalog.works.length<1000,'作品数量已达到本库当前上限');
    required(catalog.works.reduce((n,w)=>n+(w.bytes??0),0)+submission.png.length+submission.thumbnail.length<=512*1024*1024,'作品容量已达到本库当前上限');
    catalog.works.push({version:1,id:submission.id,title:submission.title,author:actor.login,authorId:actor.login,githubUserId:actor.id,
      category:submission.category,profile:submission.profile,width:submission.width,height:submission.height,hash:imageHash,
      thumbnailHash:hash(submission.thumbnail),bytes:submission.png.length+submission.thumbnail.length,status:'published',createdAt});
    files.push({path:`works/${submission.id}/image.png`,bytes:submission.png},{path:`works/${submission.id}/thumbnail.png`,bytes:submission.thumbnail});
  }
  catalog.updatedAt=createdAt;catalog.works.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
  required(Buffer.byteLength(JSON.stringify(catalog))<1024*1024,'作品目录超过当前支持大小');
  return {catalog,files};
}
