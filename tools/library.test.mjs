import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodePng} from './png.mjs';
import {validateSubmission,applySubmission} from './library.mjs';

const id='c01a0000000000000000000000000001';
const alice={login:'alice',id:123},bob={login:'bob',id:456};
const png=encodePng(2,2,Buffer.from([20,180,230,255,220,40,80,200,20,30,40,0,220,190,40,255]));
const input={version:1,operation:'publish',id,title:'测试色卡',category:'wall',profile:'wall',png:png.toString('base64')};
const empty=()=>({version:1,works:[],removed:[]});
const read=value=>validateSubmission(value,`submissions/${id}.json`);
test('publication binds GitHub actor and produces normalized downloadable assets',()=>{
  const original=empty(),result=applySubmission(original,read(input),alice,'maintainer','2026-10-30T00:00:00Z');
  assert.equal(original.works.length,0);assert.equal(result.catalog.works.length,1);assert.equal(result.files.length,2);
  const work=result.catalog.works[0];assert.equal(work.authorId,'alice');assert.equal(work.githubUserId,123);
  assert.equal(work.width,2);assert.equal(work.height,2);assert.equal(work.hash.length,64);assert.ok(result.files[0].bytes.length>0);
  assert.equal(applySubmission(result.catalog,read(input),alice,'maintainer').files.length,0);
  assert.throws(()=>applySubmission(result.catalog,read(input),bob,'maintainer'),/编号/);
  assert.throws(()=>applySubmission(result.catalog,read({...input,title:'同编号不同标题'}),alice,'maintainer'),/编号/);
});
test('removal requires GitHub identity, survives login rename, and cannot resurrect removed IDs',()=>{
  const created=applySubmission(empty(),read(input),alice,'maintainer').catalog;
  const remove=read({version:1,operation:'remove',id});
  assert.throws(()=>applySubmission(created,remove,bob,'maintainer'),/原投稿账号/);
  const renamed=applySubmission(created,remove,{login:'new-alice',id:123},'maintainer');
  assert.equal(renamed.catalog.works.length,0);assert.equal(renamed.files.length,2);assert.ok(renamed.files.every(f=>f.remove));
  assert.equal(applySubmission(renamed.catalog,remove,alice,'maintainer').files.length,0);
  assert.throws(()=>applySubmission(renamed.catalog,read(input),alice,'maintainer'),/下架/);
  assert.equal(applySubmission(created,remove,{login:'maintainer',id:789},'maintainer').catalog.works.length,0);
});
test('only bounded artwork data is accepted, including matching tattoo canvases',()=>{
  assert.throws(()=>read({...input,authorId:'maintainer'}),/不支持的字段/);
  assert.throws(()=>read({...input,script:'do not execute'}),/不支持的字段/);
  assert.throws(()=>validateSubmission(input,'../escape.json'),/submissions/);
  assert.throws(()=>read({...input,profile:'phone'}),/画布/);
  assert.throws(()=>read({...input,png:'not-base64'}),/编码/);
  assert.throws(()=>read({...input,version:999}),/版本/);
  const tattoo=read({...input,category:'tattoo',profile:'spray-back-v1/sia'});assert.equal(tattoo.profile,'spray-back-v1/sia');
  assert.throws(()=>read({...input,category:'tattoo',profile:'spray-back-v1/unknown'}),/画布/);
  assert.throws(()=>applySubmission({version:2,works:[]},read(input),alice,'maintainer'),/目录/);
});
