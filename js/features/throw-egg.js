/* ============================================================
   搞怪：朝梦角头像扔番茄/鸡蛋/蛋糕/泼水（斗地主同款彩蛋）
   - 入口在输入区"更多"面板里的"搞怪"：点了收起更多面板，在屏幕右下角
     弹出道具面板（四个按钮，图标就是各角色的静态画面，没有文字），
     有关闭按钮；不关就可以一直扔
   - 道具全部是 SVG 手绘 + GSAP（js/vendor/gsap.min.js）做的动作，
     不依赖任何图片/视频素材
   - 聊天记录：命中时插一条跟视频通话记录同款的事件气泡
     （window._addCallEvent），文案"我 向 梦角 扔了 番茄"/"我 向 梦角 泼水"。
     连续扔同一种只保留一条：只有当上一条气泡是聊天记录的最后一条、
     同一个人扔的、同一种道具、而且是同一次打开面板时才合并；
     换道具、中间插了别的消息、关掉面板再打开，都会新起一条
   - 回复时机：用户扔的时候不立刻触发梦角回复，等用户停手 3 秒、或点关闭
     面板（以先到的为准），才当作"一轮消息发完"调一次 window._triggerDelayedReply(true)，
     走正常的已读 -> 正在输入 -> 回复（也可能已读不回）流程，一轮只触发一次
   - 目标头像：扔向聊天区里当前可见、最靠下的那个头像（用户扔 -> 梦角的，
     梦角扔 -> 我的），找不到才退回头部的头像
   - 梦角也会扔：core.js 的 simulateReply 里跟拍一拍同样 3% 判定，
     调 window.ThrowEgg.partnerThrow()，从梦角头像飞向"我"的头像
   ============================================================ */

(function () {
  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs){
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function starPoints(cx, cy, rOuter, rInner, spikes, rotOffset){
    let pts = [];
    const step = Math.PI / spikes;
    let rot = -Math.PI / 2 + (rotOffset || 0);
    for (let i = 0; i < spikes * 2; i++){
      const r = (i % 2 === 0) ? rOuter : rInner;
      pts.push((cx + Math.cos(rot) * r).toFixed(1) + ',' + (cy + Math.sin(rot) * r).toFixed(1));
      rot += step;
    }
    return pts.join(' ');
  }
  function jaggedBurst(cx, cy, baseR, spikes, seedOffset){
    // 用随机振幅的多边形模拟"炸裂开的不规则轮廓"，seedOffset 用来让每种道具的裂口形状略有差异
    let pts = [];
    for (let i = 0; i < spikes; i++){
      const ang = (Math.PI * 2 * i / spikes);
      const wig = Math.sin(i * 1.7 + seedOffset) * 0.35 + Math.cos(i * 0.9 + seedOffset) * 0.2;
      const r = baseR * (1 + wig);
      pts.push((cx + Math.cos(ang) * r).toFixed(1) + ',' + (cy + Math.sin(ang) * r).toFixed(1));
    }
    return 'M' + pts.join(' L') + ' Z';
  }

  // 圆润的不规则"摊开"轮廓（蛋白、奶油用），用二次曲线串起来，没有尖角
  function smoothBlob(cx, cy, r, n, seed, amp){
    const pts = [];
    for (let i = 0; i < n; i++){
      const ang = Math.PI * 2 * i / n;
      const rr = r * (1 + amp * Math.sin(i * 2.3 + seed) + amp * 0.5 * Math.cos(i * 1.1 + seed));
      pts.push([cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr]);
    }
    const mid = (p, q) => [(p[0]+q[0])/2, (p[1]+q[1])/2];
    let m = mid(pts[n-1], pts[0]);
    let d = 'M' + m[0].toFixed(1) + ',' + m[1].toFixed(1);
    for (let i = 0; i < n; i++){
      const p = pts[i], q = mid(pts[i], pts[(i+1)%n]);
      d += ' Q' + p[0].toFixed(1) + ',' + p[1].toFixed(1) + ' ' + q[0].toFixed(1) + ',' + q[1].toFixed(1);
    }
    return d + ' Z';
  }

  // ================= 各道具的"画法"：返回 {svg, root, body, mark} =================
  const BUILDERS = {
    tomato: function(){
      const svg = el('svg', { viewBox:'0 0 120 120', class:'char-svg' });
      const defs = el('defs', {});
      const grad = el('radialGradient', { id:'g-tomato', cx:'38%', cy:'32%', r:'75%' });
      grad.appendChild(el('stop', { offset:'0%', 'stop-color':'#ff7a5c' }));
      grad.appendChild(el('stop', { offset:'60%', 'stop-color':'#e8503a' }));
      grad.appendChild(el('stop', { offset:'100%', 'stop-color':'#c43a28' }));
      defs.appendChild(grad); svg.appendChild(defs);
      const root = el('g', {}); svg.appendChild(root);
      const body = el('path', { d:'M60.0,14.0 C71.2,15.5 89.0,25.2 100.1,40.5 C103.3,51.0 104.0,57.9 103.9,61.8 C102.3,71.5 99.8,78.1 94.3,87.2 C85.7,95.6 84.4,96.4 70.9,102.6 C60.0,104.0 52.1,103.3 44.0,100.9 C35.6,96.4 26.4,88.0 23.0,83.3 C19.5,76.6 16.5,65.8 16.0,58.2 C17.1,49.2 19.2,42.1 23.3,34.2 C30.8,25.4 42.3,17.8 49.5,15.3 C53.7,14.5 56.3,14.2 60.0,14.0 Z',
        fill:'url(#g-tomato)', stroke:'#9c2e20', 'stroke-width':'2.5' });
      root.appendChild(body);
      root.appendChild(el('ellipse', { cx:'42', cy:'38', rx:'15', ry:'9', fill:'#ffffff', opacity:'0.5', transform:'rotate(-24 42 38)' }));
      root.appendChild(el('circle', { cx:'33', cy:'54', r:'4', fill:'#ffffff', opacity:'0.35' }));
      const mark = el('polygon', { points: starPoints(58, 58, 16, 7, 5), fill:'#6b4a42', opacity:'0.9' });
      root.appendChild(mark);
      return { svg, root, body, mark, kind:'splat', seed:0,
        burstPath:'M60,10 C74,6 96,18 102,40 C110,50 100,58 108,62 C112,74 92,74 96,88 C88,98 78,86 70,98 C60,108 54,92 44,100 C30,104 28,86 18,86 C6,82 14,66 6,58 C2,46 18,42 16,30 C20,14 42,18 48,10 C52,4 56,12 60,10 Z',
        particleColors:['#e8503a', '#c43a28'], seedColor:'#7a2f20' };
    },
    egg: function(){
      const svg = el('svg', { viewBox:'0 0 120 120', class:'char-svg' });
      const defs = el('defs', {});
      const grad = el('radialGradient', { id:'g-egg', cx:'38%', cy:'30%', r:'80%' });
      grad.appendChild(el('stop', { offset:'0%', 'stop-color':'#ffffff' }));
      grad.appendChild(el('stop', { offset:'70%', 'stop-color':'#fdf3df' }));
      grad.appendChild(el('stop', { offset:'100%', 'stop-color':'#f3dfae' }));
      defs.appendChild(grad); svg.appendChild(defs);
      const root = el('g', {}); svg.appendChild(root);
      const body = el('path', { d:'M60,10 C80,10 92,42 92,66 C92,92 78,108 60,108 C42,108 28,92 28,66 C28,42 40,10 60,10 Z',
        fill:'url(#g-egg)', stroke:'#d8bd80', 'stroke-width':'2.5' });
      root.appendChild(body);
      root.appendChild(el('ellipse', { cx:'44', cy:'40', rx:'12', ry:'7', fill:'#ffffff', opacity:'0.7', transform:'rotate(-18 44 40)' }));
      // mark：撞击前一瞬才淡入的裂纹线，平时不可见
      const mark = el('path', { d:'M48,52 L54,60 L50,66 L58,76', fill:'none', stroke:'#c7a964', 'stroke-width':'2', 'stroke-linecap':'round', opacity:'0' });
      root.appendChild(mark);
      return { svg, root, body, mark, kind:'crack-egg', seed:2.1,
        particleColors:['#fdf3df', '#f3dfae'], seedColor:'#f6c945' };
    },
    cake: function(){
      const svg = el('svg', { viewBox:'0 0 120 120', class:'char-svg' });
      const defs = el('defs', {});
      const sg = el('linearGradient', { id:'g-sponge', x1:'0', y1:'0', x2:'1', y2:'0' });
      sg.appendChild(el('stop', { offset:'0%', 'stop-color':'#f6d39e' }));
      sg.appendChild(el('stop', { offset:'60%', 'stop-color':'#eebd7c' }));
      sg.appendChild(el('stop', { offset:'100%', 'stop-color':'#d99c5a' }));
      defs.appendChild(sg); svg.appendChild(defs);
      const root = el('g', {}); svg.appendChild(root);
      // 圆柱蛋糕正面：蛋糕胚 + 中间一层粉色夹心 + 顶部奶油（边缘往下垂） + 樱桃
      const body = el('path', { d:'M22,56 L22,92 C22,102 98,102 98,92 L98,56 Z', fill:'url(#g-sponge)', stroke:'#b9824a', 'stroke-width':'2.5' });
      root.appendChild(body);
      root.appendChild(el('path', { d:'M22,74 C40,79 80,79 98,74 L98,80 C80,85 40,85 22,80 Z', fill:'#ffb3cc' }));
      // 顶部奶油，带几道往下垂的奶油边
      root.appendChild(el('path', { d:'M20,56 C20,44 100,44 100,56 L100,60 C96,60 95,68 91,68 C87,68 86,60 80,61 C76,62 75,71 70,71 C65,71 64,62 58,62 C53,62 52,69 47,69 C42,69 41,61 36,61 C31,61 30,66 26,66 C22,66 21,61 20,60 Z',
        fill:'#fff1f6', stroke:'#f0a8c2', 'stroke-width':'2' }));
      root.appendChild(el('ellipse', { cx:'44', cy:'51', rx:'10', ry:'2.6', fill:'#ffffff', opacity:'0.9' }));
      // 樱桃 + 小梗
      root.appendChild(el('path', { d:'M60,40 C61,34 64,30 68,28', fill:'none', stroke:'#5a7d3a', 'stroke-width':'2', 'stroke-linecap':'round' }));
      const mark = el('circle', { cx:'60', cy:'42', r:'6.5', fill:'#d6295a', stroke:'#a81c44', 'stroke-width':'1.5' });
      root.appendChild(mark);
      root.appendChild(el('circle', { cx:'58', cy:'40', r:'1.8', fill:'#ffffff', opacity:'0.7' }));
      return { svg, root, body, mark, kind:'cream', seed:4.2,
        particleColors:['#ffc1d8', '#f3c892'], seedColor:'#d6295a' };
    },
    bucket: function(){
      const svg = el('svg', { viewBox:'0 0 120 120', class:'char-svg' });
      const defs = el('defs', {});
      const grad = el('linearGradient', { id:'g-bucket', x1:'0', y1:'0', x2:'1', y2:'0' });
      grad.appendChild(el('stop', { offset:'0%', 'stop-color':'#dfe6ec' }));
      grad.appendChild(el('stop', { offset:'50%', 'stop-color':'#aebccb' }));
      grad.appendChild(el('stop', { offset:'100%', 'stop-color':'#7f93a6' }));
      defs.appendChild(grad); svg.appendChild(defs);
      const root = el('g', {}); svg.appendChild(root);
      const handle = el('path', { d:'M34,42 C34,14 86,14 86,42', fill:'none', stroke:'#5c6e80', 'stroke-width':'5', 'stroke-linecap':'round' });
      root.appendChild(handle);
      const body = el('path', { d:'M28,42 L92,42 L82,96 C82,103 38,103 38,96 Z', fill:'url(#g-bucket)', stroke:'#5c6e80', 'stroke-width':'2.5' });
      root.appendChild(body);
      root.appendChild(el('ellipse', { cx:'60', cy:'44', rx:'32', ry:'6', fill:'#c7d4df', stroke:'#5c6e80', 'stroke-width':'2' }));
      const mark = el('ellipse', { cx:'60', cy:'44', rx:'26', ry:'4.5', fill:'#5fa8e0', opacity:'0.85' }); // 桶里的水
      root.appendChild(mark);
      return { svg, root, body, mark, kind:'pour', seed:0, noSpin:true,
        particleColors:['#5fa8e0', '#8cc4ec'], seedColor:'#bfe3ff' };
    }
  };

  function spawnParticles(container, count, colors, opts){
    opts = opts || {};
    const nodes = [];
    for (let i = 0; i < count; i++){
      const isSeed = opts.seedColor && Math.random() < 0.3;
      const n = el(opts.shape === 'rect' ? 'rect' : 'circle', opts.shape === 'rect'
        ? { x: (opts.cx||60)-3, y:(opts.cy||58)-3, width:6, height:6, rx:1.5, fill: isSeed ? opts.seedColor : colors[i % colors.length] }
        : { cx: opts.cx||60, cy: opts.cy||58, r: 2 + Math.random() * 2.6, fill: isSeed ? opts.seedColor : colors[i % colors.length] });
      container.appendChild(n);
      nodes.push(n);
    }
    const tl = gsap.timeline({ onComplete(){ nodes.forEach(function(n){ n.remove(); }); } });
    nodes.forEach(function(n, i){
      const baseAngle = opts.coneCenter != null ? opts.coneCenter : (Math.PI * 2 * i / count);
      const spread = opts.coneSpread != null ? opts.coneSpread : Math.PI * 2;
      const angle = opts.coneCenter != null
        ? baseAngle + (Math.random() - 0.5) * spread
        : baseAngle + (Math.random() * 0.6 - 0.3);
      const dist = (opts.minDist||30) + Math.random() * ((opts.maxDist||76) - (opts.minDist||30));
      const tx = Math.cos(angle) * dist;
      const ty = Math.sin(angle) * dist + (opts.gravity ? 16 : 0);
      const attrKey = opts.shape === 'rect' ? { x:'+='+tx, y:'+='+ty } : { cx:'+='+tx, cy:'+='+ty };
      tl.to(n, {
        attr: attrKey,
        rotation: opts.shape==='rect' ? (Math.random()*360-180) : 0,
        transformOrigin: 'center',
        opacity: 0,
        duration: (opts.duration||0.55) + Math.random() * 0.25,
        ease: opts.ease || 'power2.out'
      }, i * (opts.stagger != null ? opts.stagger : 0.012));
    });
    return tl;
  }

  // ================= 命中特效：按 kind 分支 =================
  function impactSplat(tl, c){
    // 命中前一丝预压（顺着来向拉长一点点，经典的"落地前预判"）
    tl.to(c.root, { scaleX: 0.9, scaleY: 1.18, duration: 0.07, ease:'power1.in' })
      // 砸扁
      .to(c.root, { scaleX: 1.4, scaleY: 0.55, transformOrigin:'60px 70px', duration: 0.1, ease:'power2.out' })
      // 用弹性缓动自己回弹好几下，而不是手动分两步——这是让手感不生硬的关键
      .to(c.root, { scaleX: 1, scaleY: 1, duration: 0.6, ease:'elastic.out(1,0.35)' }, '<')
      .to(c.body, { attr:{ d: c.burstPath }, duration: 0.32, ease:'elastic.out(1,0.5)' }, '<+0.01')
      .to(c.mark, { scale: 1.3, transformOrigin:'58px 58px', opacity: 0.55, duration: 0.14 }, '<')
      .call(function(){
        spawnParticles(c.root, 13, c.particleColors, { gravity:true, seedColor:c.seedColor, minDist:26, maxDist:78, duration:0.6 });
      })
      .to(c.svg, { opacity: 0, duration: 0.45, delay: 0.38 }, '<');
  }

  function impactCrackEgg(tl, c){
    // 鸡蛋：裂纹预兆 -> 砸扁 -> 蛋壳消失碎屑飞出 -> 摊开成"蛋白+蛋黄"的煎蛋状，晃两下后淡出
    const white = el('path', { d: smoothBlob(60, 62, 36, 9, 1.3, 0.16), fill:'#fffdf6', stroke:'#eadfc4', 'stroke-width':'2', opacity:'0' });
    const yolk = el('circle', { cx:'58', cy:'58', r:'14', fill:'#f7b52b', stroke:'#e09a12', 'stroke-width':'2', opacity:'0' });
    const yolkHl = el('ellipse', { cx:'53', cy:'53', rx:'4.5', ry:'3', fill:'#fff6d6', opacity:'0' });
    c.svg.insertBefore(white, c.root); c.svg.appendChild(yolk); c.svg.appendChild(yolkHl);
    gsap.set(white, { scale:0.3, transformOrigin:'60px 62px' });
    gsap.set([yolk, yolkHl], { scale:0.2, transformOrigin:'58px 58px' });

    tl.to(c.mark, { opacity: 1, duration: 0.1 }, '-=0.05')
      .to(c.root, { scaleX: 0.92, scaleY: 1.15, duration: 0.06, ease:'power1.in' })
      .to(c.root, { scaleX: 1.4, scaleY: 0.5, transformOrigin:'60px 80px', duration: 0.09, ease:'power2.out' })
      .call(function(){
        spawnParticles(c.svg, 9, ['#fdf3df', '#f3dfae'], { shape:'rect', gravity:true, minDist:30, maxDist:70, duration:0.55 });
      })
      .to(c.root, { opacity: 0, duration: 0.08 }, '<')
      .to(white, { opacity: 1, scale: 1, duration: 0.55, ease:'elastic.out(1,0.45)' }, '<')
      .to([yolk, yolkHl], { opacity: 1, scale: 1, duration: 0.5, ease:'back.out(2.2)' }, '<+0.05')
      .to(yolk, { attr:{ cy: 60 }, duration: 0.5, ease:'sine.inOut', yoyo:true, repeat:1 }, '<+0.2')
      .to(c.svg, { opacity: 0, duration: 0.5, delay: 0.55 }, '<');
  }

  function impactCream(tl, c){
    // 蛋糕：砸扁 -> 奶油摊开成一大坨柔软的粉色 + 往下慢慢流的奶油滴，樱桃滚落，蛋糕屑崩开
    const cream = el('path', { d: smoothBlob(60, 58, 38, 10, 0.7, 0.14), fill:'#ffd3e2', stroke:'#f0a8c2', 'stroke-width':'2', opacity:'0' });
    const creamHl = el('ellipse', { cx:'46', cy:'46', rx:'10', ry:'5', fill:'#ffffff', opacity:'0', transform:'rotate(-18 46 46)' });
    const drips = [[40, 84, 18], [55, 90, 26], [71, 86, 20], [82, 78, 14]].map(function(d){
      const r = el('rect', { x: d[0]-4, y: d[1]-6, width:'8', height:'8', rx:'4', fill:'#ffd3e2', opacity:'0' });
      r._len = d[2];
      return r;
    });
    drips.forEach(function(r){ c.svg.appendChild(r); });
    c.svg.appendChild(cream); c.svg.appendChild(creamHl);
    gsap.set(cream, { scale:0.35, transformOrigin:'60px 62px' });

    tl.to(c.root, { scaleX: 0.9, scaleY: 1.15, duration: 0.06, ease:'power1.in' })
      .to(c.root, { scaleX: 1.45, scaleY: 0.45, transformOrigin:'60px 90px', duration: 0.1, ease:'power2.out' })
      .call(function(){
        spawnParticles(c.svg, 10, ['#f3c892', '#e2a568'], { shape:'rect', gravity:true, minDist:28, maxDist:66, duration:0.55 });
      })
      .to(c.root, { opacity: 0, duration: 0.1 }, '<')
      .to(cream, { opacity: 1, scale: 1, duration: 0.6, ease:'elastic.out(1,0.5)' }, '<')
      .to(creamHl, { opacity: 0.6, duration: 0.3 }, '<+0.1')
      .to(drips, { opacity: 1, duration: 0.1, stagger: 0.06 }, '<+0.05')
      .to(drips, { attr:{ height: function(i, t){ return 8 + t._len; } }, duration: 0.9, ease:'sine.out', stagger: 0.08 }, '<')
      .to(cream, { attr:{ d: smoothBlob(60, 62, 40, 10, 0.7, 0.12) }, duration: 0.9, ease:'sine.out' }, '<')
      .to(c.svg, { opacity: 0, duration: 0.5, delay: 0.1 }, '>-0.2');
  }

  function impactPour(tl, c){
    // 水桶：不旋转。到位后往前猛地一送再收回，桶里的水直接朝扔的方向泼出去
    const dir = c.dir || 0;
    const fx = Math.cos(dir), fy = Math.sin(dir);
    const mouthX = 60 + fx * 20, mouthY = 44 + fy * 10;
    const sheet = el('path', { d: smoothBlob(0, 0, 16, 9, 2.0, 0.2), fill:'#7fbbe8', opacity:'0' });
    const sheet2 = el('path', { d: smoothBlob(0, 0, 11, 8, 4.0, 0.25), fill:'#a9d4f2', opacity:'0' });
    c.svg.appendChild(sheet); c.svg.appendChild(sheet2);
    gsap.set([sheet, sheet2], { x: mouthX, y: mouthY, scale: 0.3, transformOrigin:'0px 0px' });

    tl.to(c.svg, { x: '-=' + fx * 8, y: '-=' + fy * 8, duration: 0.08, ease:'power1.out' })   // 往后蓄力
      .to(c.svg, { x: '+=' + fx * 22, y: '+=' + fy * 22, duration: 0.09, ease:'power3.in' })   // 猛地往前送
      .call(function(){
        spawnParticles(c.svg, 24, ['#5fa8e0', '#8cc4ec', '#bfe3ff'], {
          cx: mouthX, cy: mouthY, gravity:true, coneCenter: dir, coneSpread: Math.PI * 0.5,
          minDist: 50, maxDist: 120, duration: 0.65, ease:'power2.out', stagger: 0.006
        });
      })
      .to(c.mark, { opacity: 0, duration: 0.12 }, '<')
      .to(sheet, { opacity: 0.9, scale: 1.8, x: mouthX + fx * 60, y: mouthY + fy * 60 + 4, duration: 0.32, ease:'power2.out' }, '<')
      .to(sheet2, { opacity: 0.85, scale: 1.6, x: mouthX + fx * 42, y: mouthY + fy * 42 - 6, duration: 0.28, ease:'power2.out' }, '<+0.03')
      .to([sheet, sheet2], { opacity: 0, scaleX: 2.3, scaleY: 1.2, y: '+=8', duration: 0.4, ease:'power1.in' })
      .to(c.svg, { x: '-=' + fx * 14, y: '-=' + fy * 14, duration: 0.45, ease:'elastic.out(1,0.5)' }, '<-0.3')
      .to(c.svg, { opacity: 0, duration: 0.35 }, '>-0.15');
  }

  const IMPACTS = { splat: impactSplat, 'crack-egg': impactCrackEgg, cream: impactCream, pour: impactPour };

  // ================= 下面是接进项目的部分 =================
  const ITEMS = [
    { id:'tomato', name:'番茄', callIcon:'fa-explosion' },
    { id:'egg',    name:'鸡蛋', callIcon:'fa-explosion' },
    { id:'cake',   name:'蛋糕', callIcon:'fa-cake-candles' },
    { id:'bucket', name:'水桶', callIcon:'fa-droplet' }
  ];
  const CHAR_SIZE = 80; // 飞行中角色的显示尺寸（px）

  function getPartnerName() {
    try { if (typeof settings !== 'undefined' && settings.partnerName) return settings.partnerName; } catch (e) {}
    return '梦角';
  }
  function getMyName() {
    try { if (typeof settings !== 'undefined' && settings.myName) return settings.myName; } catch (e) {}
    return '我';
  }
  function getMessages() {
    try { if (typeof messages !== 'undefined' && Array.isArray(messages)) return messages; } catch (e) {}
    return Array.isArray(window.messages) ? window.messages : [];
  }
  // 落点：番茄/鸡蛋/蛋糕落在头像旁边 20px 处，高度在头像中部，稍有上下随机；
  // 用户扔梦角 → 梦角头像右边（side='right'）；梦角扔用户 → 用户头像左边（side='left'）；
  // 水桶的泼水效果保持原样，仍然对准头像中心
  function aimPoint(elm, itemId, side) {
    const c = centerOf(elm);
    if (itemId === 'bucket') return c;
    // 落在头像左侧（头像左边缘再往左 20px），高度在头像中部，稍有上下随机
    const dx = c.w * 0.5 + 20;
    return { x: side === 'right' ? c.x + dx : c.x - dx, y: c.y + (Math.random() - 0.5) * c.h * 0.3 };
  }
  function centerOf(elm) {
    const r = elm.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }

  // 同一个角色会同时出现在面板图标和飞行动画里，SVG 里渐变的 id 必须唯一，
  // 不然一个被移除后另一个的 url(#id) 会失效
  let _uid = 0;
  function uniquify(svg) {
    const suffix = '-te' + (++_uid);
    svg.querySelectorAll('[id]').forEach(function (n) {
      const old = n.id, neu = old + suffix;
      n.id = neu;
      svg.querySelectorAll('[fill="url(#' + old + ')"]').forEach(function (m) { m.setAttribute('fill', 'url(#' + neu + ')'); });
    });
    return svg;
  }
  function buildChar(id) {
    const c = BUILDERS[id]();
    uniquify(c.svg);
    c.svg.setAttribute('class', 'throw-char-svg');
    return c;
  }

  function getLayer() {
    let layer = document.getElementById('throw-fx-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'throw-fx-layer';
      document.body.appendChild(layer);
    }
    return layer;
  }

  function shake(elm) {
    if (!elm) return;
    gsap.killTweensOf(elm);
    gsap.to(elm, {
      keyframes: [{ x: -4, rotation: -6 }, { x: 4, rotation: 5 }, { x: -2, rotation: -2 }, { x: 0, rotation: 0 }],
      duration: 0.4, ease: 'power1.inOut', clearProps: 'transform'
    });
  }

  // 飞行 + 命中。from/to 是视口坐标（px）；onHit 在落到目标那一刻调用
  function playSequence(id, from, to, onHit) {
    const c = buildChar(id);
    getLayer().appendChild(c.svg);
    c.dir = Math.atan2(to.y - from.y, to.x - from.x);

    // 水桶不砸到脸上：停在目标前面一点，再把水泼过去
    if (c.noSpin) {
      to = { x: to.x - Math.cos(c.dir) * 58, y: to.y - Math.sin(c.dir) * 58 };
    }
    const half = CHAR_SIZE / 2;
    const fromX = from.x - half, fromY = from.y - half, toX = to.x - half, toY = to.y - half;
    gsap.set(c.svg, { x: fromX, y: fromY, scale: 0.55, opacity: 0.95, rotation: 0 });

    const tl = gsap.timeline({ onComplete: function () { setTimeout(function () { c.svg.remove(); }, 700); } });
    const midX = (fromX + toX) / 2, midY = Math.min(fromY, toY) - 60 - Math.abs(toY - fromY) * 0.25;

    tl.to(c.svg, { scale: 1, duration: 0.12, ease: 'power1.out' })
      .to(c.svg, { x: fromX + (midX - fromX) * 0.55, y: fromY + (midY - fromY) * 0.8, rotation: c.noSpin ? 0 : 95, duration: 0.16, ease: 'power1.out' }, '<')
      .to(c.svg, { x: midX, y: midY, rotation: c.noSpin ? 0 : 190, scale: 1.08, duration: 0.14, ease: 'sine.inOut' })
      .to(c.svg, { x: fromX * 0.15 + toX * 0.85, y: fromY * 0.1 + toY * 0.9, rotation: c.noSpin ? 0 : 300, duration: 0.14, ease: 'power1.in' })
      .to(c.svg, { x: toX, y: toY, rotation: c.noSpin ? 0 : 360, scale: 1, duration: 0.09, ease: 'power2.in' })
      .call(function () { if (typeof onHit === 'function') onHit(); });

    IMPACTS[c.kind](tl, c);
    return tl;
  }

  // ---------- 聊天记录气泡（连续同一种只保留一条） ----------
  let panelSession = 0;   // 每次打开面板 +1，关掉面板再打开就算新的一轮
  let lastThrow = null;   // { sender, itemId, session, msg }

  function labelFor(sender, item) {
    const a = sender === 'user' ? getMyName() : getPartnerName();
    const b = sender === 'user' ? getPartnerName() : getMyName();
    return item.id === 'bucket' ? (a + ' 向 ' + b + ' 泼水') : (a + ' 向 ' + b + ' 扔了 ' + item.name);
  }

  // 返回 true 表示新起了一条气泡；false 表示合并进了上一条
  function recordThrow(sender, item) {
    const list = getMessages();
    const last = list[list.length - 1];
    const merge = lastThrow && last && lastThrow.msg === last &&
      lastThrow.sender === sender && lastThrow.itemId === item.id &&
      (sender !== 'user' || lastThrow.session === panelSession);
    if (merge) return false;
    if (typeof window._addCallEvent !== 'function') return false;
    window._addCallEvent(item.callIcon, labelFor(sender, item), null);
    const list2 = getMessages();
    lastThrow = { sender: sender, itemId: item.id, session: panelSession, msg: list2[list2.length - 1] };
    return true;
  }

  // ---------- 找聊天区里最近的头像 ----------
  // side: 'received' = 梦角的消息头像，'sent' = 我的消息头像。
  // 只看当前在聊天区可视范围内、没被隐藏的，取最靠下（也就是最新、离输入框最近）的一个
  function nearestChatAvatar(side, fallbackId) {
    const container = document.getElementById('chat-container');
    if (container) {
      const cr = container.getBoundingClientRect();
      const list = container.querySelectorAll('.message-wrapper.' + side + ' .message-avatar');
      let best = null, bestBottom = -Infinity;
      list.forEach(function (elm) {
        if (getComputedStyle(elm).visibility === 'hidden' || getComputedStyle(elm).display === 'none') return;
        const r = elm.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (r.bottom < cr.top + 4 || r.top > cr.bottom - 4) return;
        if (r.bottom > bestBottom) { best = elm; bestBottom = r.bottom; }
      });
      if (best) return best;
    }
    return document.getElementById(fallbackId);
  }

  // ---------- 回复时机：停手 3 秒 / 关面板，才算"一轮消息发完" ----------
  const IDLE_MS = 3000;
  let replyTimer = null, replyDirty = false;
  function flushReply() {
    if (replyTimer) { clearTimeout(replyTimer); replyTimer = null; }
    if (!replyDirty) return;
    replyDirty = false;
    if (typeof window._triggerDelayedReply === 'function') window._triggerDelayedReply(true);
  }
  function markReplyPending() {
    replyDirty = true;
    if (replyTimer) clearTimeout(replyTimer);
    replyTimer = setTimeout(flushReply, IDLE_MS);
  }

  // ---------- 用户扔 ----------
  function userThrow(itemId, fromEl) {
    const item = ITEMS.find(function (i) { return i.id === itemId; });
    const avatar = nearestChatAvatar('received', 'partner-avatar');
    if (!item || !avatar) return;
    const from = fromEl ? centerOf(fromEl) : { x: window.innerWidth - 60, y: window.innerHeight - 120 };
    playSequence(item.id, from, aimPoint(avatar, item.id, 'right'), function () {
      shake(avatar);
      recordThrow('user', item);
      markReplyPending();
    });
  }

  // ---------- 梦角扔（由 simulateReply 里的 3% 判定调用） ----------
  function hideTypingIndicator() {
    try {
      if (window._typingIndicatorAutoHideTimer) { clearTimeout(window._typingIndicatorAutoHideTimer); window._typingIndicatorAutoHideTimer = null; }
      const w = document.getElementById('typing-indicator-wrapper');
      if (w) w.style.display = 'none';
    } catch (e) {}
  }
  function partnerThrow(itemId) {
    const item = ITEMS.find(function (i) { return i.id === itemId; }) || ITEMS[Math.floor(Math.random() * ITEMS.length)];
    hideTypingIndicator();
    const fromEl = nearestChatAvatar('received', 'partner-avatar');
    const toEl = nearestChatAvatar('sent', 'my-avatar');
    const done = function () { shake(toEl); recordThrow('partner', item); };
    if (!fromEl || !toEl || toEl.getBoundingClientRect().width === 0) { done(); return; }
    playSequence(item.id, centerOf(fromEl), aimPoint(toEl, item.id, 'left'), done);
  }

  // ---------- 右下角道具面板 ----------
  function positionPanel(panel) {
    const anchor = document.querySelector('.input-area-wrapper') || document.getElementById('more-menu-btn');
    const top = anchor ? anchor.getBoundingClientRect().top : window.innerHeight - 70;
    panel.style.bottom = Math.max(8, window.innerHeight - top + 10) + 'px';
  }
  function onResize() {
    const panel = document.getElementById('throw-fx-panel');
    if (panel) positionPanel(panel);
  }
  function closePanel() {
    const panel = document.getElementById('throw-fx-panel');
    if (panel) panel.remove();
    window.removeEventListener('resize', onResize);
    panelSession++; // 关掉就算这一轮结束，再打开扔同一种会新起一条
    flushReply();   // 关面板 = 这一轮发完了，立刻进入正常的"已读 / 正在输入 / 回复"流程
  }
  function openPanel() {
    if (typeof gsap === 'undefined') {
      if (typeof showNotification === 'function') showNotification('搞怪动效加载失败，请刷新后再试', 'warning', 2400);
      return;
    }
    if (document.getElementById('throw-fx-panel')) return;
    panelSession++;

    const panel = document.createElement('div');
    panel.id = 'throw-fx-panel';
    panel.className = 'throw-fx-panel';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'throw-fx-close';
    closeBtn.title = '关闭';
    closeBtn.innerHTML = '<i class="fas fa-xmark"></i>';
    closeBtn.addEventListener('click', function (e) { e.stopPropagation(); closePanel(); });
    panel.appendChild(closeBtn);

    const grid = document.createElement('div');
    grid.className = 'throw-fx-grid';
    ITEMS.forEach(function (item) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'throw-fx-item';
      btn.setAttribute('aria-label', item.name);
      btn.appendChild(buildChar(item.id).svg); // 静态的一帧当图标
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        gsap.fromTo(btn, { scale: 0.88 }, { scale: 1, duration: 0.35, ease: 'back.out(3)', clearProps: 'transform' });
        userThrow(item.id, btn);
      });
      grid.appendChild(btn);
    });
    panel.appendChild(grid);
    document.body.appendChild(panel);
    positionPanel(panel);
    window.addEventListener('resize', onResize);
    gsap.fromTo(panel, { opacity: 0, y: 8, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.18, ease: 'power2.out', clearProps: 'transform' });
  }

  window.ThrowEgg = {
    openPanel: openPanel,
    closePanel: closePanel,
    userThrow: userThrow,
    partnerThrow: partnerThrow
  };

  document.addEventListener('DOMContentLoaded', function () {
    if (window.MoreMenu && typeof window.MoreMenu.registerItem === 'function') {
      window.MoreMenu.registerItem('throw-egg', { ready: true, action: openPanel });
    }
  });
})();
