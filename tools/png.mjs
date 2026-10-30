import { deflateSync, inflateSync } from 'node:zlib';

const signature = Buffer.from([137,80,78,71,13,10,26,10]);
const table = Array.from({length:256}, (_, n) => {
  for (let i=0;i<8;i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc(data) {
  let n=0xffffffff;
  for (const b of data) n=table[(n^b)&255]^(n>>>8);
  return (n^0xffffffff)>>>0;
}
function chunk(type, bytes) {
  const name=Buffer.from(type), result=Buffer.alloc(bytes.length+12);
  result.writeUInt32BE(bytes.length);name.copy(result,4);bytes.copy(result,8);
  result.writeUInt32BE(crc(Buffer.concat([name,bytes])),8+bytes.length);
  return result;
}
export function encodePng(width,height,rgba) {
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const stride=width*4, rows=Buffer.alloc((stride+1)*height);
  for(let y=0;y<height;y++) Buffer.from(rgba.buffer,rgba.byteOffset+y*stride,stride).copy(rows,y*(stride+1)+1);
  return Buffer.concat([signature,chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
function paeth(a,b,c) {
  const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
  return pa<=pb&&pa<=pc?a:pb<=pc?b:c;
}
export function normalizePng(bytes) {
  if(bytes.length>8*1024*1024||bytes.length<45||!bytes.subarray(0,8).equals(signature)) throw Error('请选择不超过8MB的PNG');
  let width=0,height=0,channels=0,ended=false,started=false,idatEnded=false;const compressed=[];
  for(let offset=8;offset<bytes.length;) {
    if(offset+12>bytes.length) throw Error('PNG文件不完整');
    const length=bytes.readUInt32BE(offset),end=offset+12+length;
    if(end>bytes.length) throw Error('PNG区块长度无效');
    const type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,end-4);
    if(crc(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4)) throw Error('PNG区块校验失败');
    if(offset===8&&type!=='IHDR') throw Error('PNG缺少图像头');
    if(type==='IHDR') {
      if(width||length!==13) throw Error('PNG图像头无效');
      width=data.readUInt32BE(0);height=data.readUInt32BE(4);channels=data[9]===6?4:data[9]===2?3:0;
      if(width<1||height<1||width>2048||height>2048||data[8]!==8||!channels||data[10]||data[11]||data[12])
        throw Error('作品需为1–2048像素、8位RGB/RGBA非交错PNG；请从喷罐分享页重新读取图片');
    } else if(type==='IDAT') {
      if(idatEnded) throw Error('PNG数据区块不连续');
      started=true;compressed.push(data);
    } else if(type==='IEND') {
      if(length||!started||end!==bytes.length) throw Error('PNG结束区块无效');
      ended=true;break;
    } else {
      if(started) idatEnded=true;
      if(type!=='PLTE' && type[0]===type[0].toUpperCase()) throw Error('PNG包含不支持的关键区块');
      if(type==='tRNS') throw Error('请在喷罐分享页重新读取图片，转换为RGBA透明PNG');
    }
    offset=end;
  }
  if(!ended||!width) throw Error('PNG文件不完整');
  const stride=width*channels,expected=(stride+1)*height;
  const rows=inflateSync(Buffer.concat(compressed),{maxOutputLength:expected+1});
  if(rows.length!==expected) throw Error('PNG像素数据长度不匹配');
  const raw=Buffer.alloc(stride*height),rgba=Buffer.alloc(width*height*4);let visible=false;
  for(let y=0;y<height;y++) {
    const filter=rows[y*(stride+1)];if(filter>4) throw Error('PNG过滤方式无效');
    for(let x=0;x<stride;x++) {
      const a=x>=channels?raw[y*stride+x-channels]:0,b=y?raw[(y-1)*stride+x]:0,c=y&&x>=channels?raw[(y-1)*stride+x-channels]:0;
      const predictor=[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter];
      raw[y*stride+x]=(rows[y*(stride+1)+x+1]+predictor)&255;
    }
    for(let x=0;x<width;x++) {
      const from=y*stride+x*channels,to=(y*width+x)*4;
      raw.copy(rgba,to,from,from+3);rgba[to+3]=channels===4?raw[from+3]:255;
      visible ||= rgba[to+3]>0;
    }
  }
  if(!visible) throw Error('不能分享全透明图片');
  const png=encodePng(width,height,rgba);
  if(png.length>8*1024*1024) throw Error('处理后的作品超过8MB，请缩小图片');
  const scale=Math.min(1,128/Math.max(width,height)),tw=Math.max(1,Math.round(width*scale)),th=Math.max(1,Math.round(height*scale));
  const pixels=Buffer.alloc(tw*th*4);
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++) {
    const from=(Math.floor(y*height/th)*width+Math.floor(x*width/tw))*4;
    rgba.copy(pixels,(y*tw+x)*4,from,from+4);
  }
  return {width,height,png,thumbnail:encodePng(tw,th,pixels)};
}
