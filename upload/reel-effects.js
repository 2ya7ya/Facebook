(function () {
  'use strict';

  const removedEffectIds = new Set([
    'rgb-split','glitch','datamosh','block-glitch',
    'vhs','old-tv','scanlines','grain',
    'shake-2','light-leak','digital-rain','liquid-glass',
    'half-face-whirl','laser','bloom','bling'
  ]);
  const catalog = [
    ['none', 'None', 'Basic'],
    ['rgb-split', 'RGB Split', 'Glitch'],
    ['glitch', 'Glitch', 'Glitch'],
    ['vhs', 'VHS', 'Retro'],
    ['old-tv', 'Old TV', 'Retro'],
    ['scanlines', 'Scanlines', 'Retro'],
    ['pixelate', 'Pixelate', 'Digital'],
    ['posterize', 'Posterize', 'Digital'],
    ['edge-glow', 'Edge Glow', 'Digital'],
    ['thermal', 'Thermal', 'Digital'],
    ['mirror', 'Mirror', 'Distort'],
    ['split-screen', 'Split Screen', 'Distort'],
    ['kaleidoscope', 'Kaleidoscope', 'Distort'],
    ['fisheye', 'Fisheye', 'Distort'],
    ['ripple', 'Ripple', 'Motion'],
    ['wave', 'Wave', 'Motion'],
    ['zoom-pulse', 'Zoom Pulse', 'Motion'],
    ['shake', 'Shake', 'Motion'],
    ['strobe', 'Strobe', 'Motion'],
    ['ghost', 'Ghost', 'Motion'],
    ['tunnel', 'Tunnel', 'Creative'],
    ['bloom', 'Bloom', 'Light'],
    ['grain', 'Grain', 'Retro'],
    ['vignette', 'Vignette', 'Lens'],
    ['bokeh-blur', 'Bokeh Blur', 'Lens'],
    ['lens-flare', 'Lens Flare', 'Light'],
    ['motion-blur', 'Motion Blur', 'Motion'],
    ['bling', 'Bling', 'Light'],
    ['dynamic-distort', 'Dynamic Distort', 'Distort'],
    ['prism', 'Prism', 'Lens'],
    ['light-leak', 'Light Leak', 'Light'],
    ['datamosh', 'Datamosh', 'Glitch'],
    ['block-glitch', 'Block Glitch', 'Glitch'],
    ['digital-rain', 'Digital Rain', 'Digital'],
    ['color-trails', 'Color Trails', 'Motion'],
    ['echo-zoom', 'Echo Zoom', 'Motion'],
    ['radial-blur', 'Radial Blur', 'Motion'],
    ['swirl', 'Swirl', 'Distort'],
    ['stretch', 'Stretch', 'Distort'],
    ['liquid-glass', 'Liquid Glass', 'Creative'],
    ['flash-zoom', 'Flash Zoom', 'Motion'],
    ['dream-glow', 'Dream Glow', 'Light'],
    ['mini-zoom', 'Mini Zoom', 'Basic'],
    ['zoom-lens', 'Zoom Lens', 'Basic'],
    ['blur', 'Blur', 'Basic'],
    ['shaky-camera-move', 'Shaky Camera Move', 'Dynamic'],
    ['delay', 'Delay', 'Dynamic'],
    ['shake-2', 'Shake 2', 'Dynamic'],
    ['astral', 'Astral', 'Dynamic'],
    ['shake-1', 'Shake 1', 'Dynamic'],
    ['neon-dynamic', 'Neon', 'Dynamic'],
    ['bounce-camera', 'Bounce Camera', 'Dynamic'],
    ['trembling', 'Trembling', 'Dynamic'],
    ['black-flash', 'Black Flash', 'Dynamic'],
    ['shake-dynamic', 'Shake', 'Dynamic'],
    ['soul', 'Soul', 'Dynamic'],
    ['disco-count', 'Disco Count', 'Fancy'],
    ['lyric-cut', 'Lyric Cut', 'Fancy', 58],
    ['quick-speed', 'Quick Speed', 'Fancy', 59],
    ['energy', 'Energy', 'Fancy', 62],
    ['moon-off', 'Moon Off', 'Fancy', 63],
    ['shockwave', 'Shockwave', 'Fancy', 64],
    ['somethings-wrong', "Something's Wrong", 'Fancy', 65],
    ['small-body-big-head', 'Small Body Big Head', 'Face Effect', 66],
    ['black-glasses', 'Black Glasses', 'Face Effect', 67],
    ['halo', 'Halo', 'Face Effect', 68],
    ['facial-fisheye', 'Facial Fisheye', 'Face Effect', 69],
    ['half-face-whirl', 'Half Face Whirl', 'Face Effect', 70],
    ['laser-eyes', 'Laser Eyes', 'Face Effect', 71],
    ['shy', 'Shy', 'Face Effect', 72],
    ['feeling-hurt', 'Feeling Hurt', 'Face Effect', 73],
    ['face-mosaic', 'Face Mosaic', 'Face Effect', 74],
    ['laser', 'Laser', 'Face Effect', 75]
  ].map(function (item, index) { return { id: item[0], name: item[1], category: item[2], mode: item[3] == null ? index : item[3] }; }).filter(function (effect) { return !removedEffectIds.has(effect.id); });
  const modes = Object.fromEntries(catalog.map(function (effect) { return [effect.id, effect.mode]; }));

  const vertexSource = [
    'attribute vec2 a_position;',
    'varying vec2 v_uv;',
    'void main(){v_uv=(a_position+1.0)*0.5;gl_Position=vec4(a_position,0.0,1.0);}'
  ].join('\n');
  const fragmentSource = [
    'precision mediump float;',
    'uniform sampler2D u_image; uniform vec2 u_resolution; uniform float u_time; uniform int u_mode; uniform vec4 u_face; uniform vec4 u_eyes;',
    'varying vec2 v_uv;',
    'float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
    'vec4 tex(vec2 p){return texture2D(u_image,clamp(p,0.001,0.999));}',
    'void main(){',
    ' vec2 uv=v_uv; vec2 p=uv-.5; vec4 c=tex(uv); float t=u_time;',
    ' if(u_mode==1){float d=.012+.006*sin(t*3.0);c=vec4(tex(uv+vec2(d,0.)).r,tex(uv).g,tex(uv-vec2(d,0.)).b,1.);}',
    ' else if(u_mode==2){float tick=floor(t*15.);float burst=step(.48,hash(vec2(tick,9.)));float row=floor(uv.y*52.);float band=step(.55,hash(vec2(row,tick)))*burst;float off=(hash(vec2(row,tick+3.))-.5)*.14*band;vec2 q=uv+vec2(off,0.);float split=.008+.02*band;c=vec4(tex(q+vec2(split,0.)).r,tex(q).g,tex(q-vec2(split,0.)).b,1.);float line=step(.965,fract(uv.y*u_resolution.y*.5+t*24.));c.rgb+=line*vec3(.3,.34,.4);}',
    ' else if(u_mode==3){float wob=sin(uv.y*80.+t*5.)*.003+sin(uv.y*13.+t*2.)*.006;c=tex(uv+vec2(wob,0.));float scan=.88+.12*sin(uv.y*u_resolution.y*1.25);float noise=(hash(uv*u_resolution.xy+floor(t*30.))-.5)*.12;c.rgb=c.rgb*scan+noise;c.r+=.025;c.b+=.035;}',
    ' else if(u_mode==5){c.rgb*=.72+.28*sin(uv.y*u_resolution.y*1.55);}',
    ' else if(u_mode==6){vec2 size=vec2(28.,50.);uv=(floor(uv*size)+.5)/size;c=tex(uv);}',
    ' else if(u_mode==7){c.rgb=floor(c.rgb*5.)/5.;c.rgb=pow(c.rgb,vec3(.88));}',
    ' else if(u_mode==8){vec2 px=1./u_resolution;vec3 gx=tex(uv+vec2(px.x,0.)).rgb-tex(uv-vec2(px.x,0.)).rgb;vec3 gy=tex(uv+vec2(0.,px.y)).rgb-tex(uv-vec2(0.,px.y)).rgb;float e=length(gx)+length(gy);c.rgb=mix(c.rgb*.22,vec3(e*.3,e*1.4,e*2.2),.85);}',
    ' else if(u_mode==9){float l=dot(c.rgb,vec3(.299,.587,.114));c.rgb=clamp(vec3(1.5-abs(4.*l-3.),1.5-abs(4.*l-2.),1.5-abs(4.*l-1.)),0.,1.);}',
    ' else if(u_mode==10){uv.x=abs(uv.x-.5)+.5;c=tex(uv);}',
    ' else if(u_mode==11){uv=fract(uv*vec2(2.,2.));if(mod(floor(v_uv.x*2.)+floor(v_uv.y*2.),2.)>0.)uv.x=1.-uv.x;c=tex(uv);}',
    ' else if(u_mode==12){float a=atan(p.y,p.x);float r=length(p);float seg=3.14159265/3.;a=abs(mod(a,seg)-seg*.5);uv=.5+vec2(cos(a),sin(a))*r;c=tex(uv);}',
    ' else if(u_mode==13){float r=length(p);uv=.5+p*(1.-.72*r*r);c=tex(uv);c.rgb*=1.-smoothstep(.52,.72,r);}',
    ' else if(u_mode==14){float r=length(p);uv+=normalize(p+vec2(.0001))*sin(r*38.-t*7.)*.012;c=tex(uv);}',
    ' else if(u_mode==15){uv.x+=sin(uv.y*15.+t*4.)*.025;uv.y+=cos(uv.x*12.+t*3.)*.012;c=tex(uv);}',
    ' else if(u_mode==16){float z=1.+.12*sin(t*4.);uv=.5+p/z;c=tex(uv);}',
    ' else if(u_mode==17){float k=floor(t*24.);vec2 j=(vec2(hash(vec2(k,1.)),hash(vec2(k,2.)))-.5)*.07;float a=(hash(vec2(k,7.))-.5)*.045;mat2 r=mat2(cos(a),-sin(a),sin(a),cos(a));vec2 q=.5+r*(p*.96)+j;c=tex(q);}',
    ' else if(u_mode==18){float f=.42+.58*step(.48,sin(t*13.));c.rgb*=f;}',
    ' else if(u_mode==19){vec2 o=vec2(.018*sin(t*2.4),.012*cos(t*1.7));c=mix(c,tex(uv+o),.42);c=mix(c,tex(uv-o*1.8),.2);}',
    ' else if(u_mode==20){float a=atan(p.y,p.x)+t*.28;float r=length(p);uv=vec2(fract(a/6.28318*2.+r*1.8),fract(r*2.-t*.12));c=tex(uv);}',
    ' else if(u_mode==21){vec2 q=2.5/u_resolution;vec3 b=(tex(uv+vec2(q.x,0.)).rgb+tex(uv-vec2(q.x,0.)).rgb+tex(uv+vec2(0.,q.y)).rgb+tex(uv-vec2(0.,q.y)).rgb)*.25;c.rgb+=max(b-vec3(.52),0.)*1.35;}',
    ' else if(u_mode==22){float n=hash(floor(uv*u_resolution.xy)+floor(t*24.));c.rgb+=(n-.5)*.22;c.rgb=mix(c.rgb,vec3(dot(c.rgb,vec3(.299,.587,.114))),.08);}',
    ' else if(u_mode==23){float d=dot(p*vec2(.8,1.1),p*vec2(.8,1.1));float v=1.-smoothstep(.10,.48,d);c.rgb*=.22+.78*v;}',
    ' else if(u_mode==24){vec2 q=5./u_resolution;c=(tex(uv)*4.+tex(uv+vec2(q.x,0.))+tex(uv-vec2(q.x,0.))+tex(uv+vec2(0.,q.y))+tex(uv-vec2(0.,q.y))+tex(uv+q)+tex(uv-q)+tex(uv+vec2(q.x,-q.y))+tex(uv+vec2(-q.x,q.y)))/12.;}',
    ' else if(u_mode==25){vec2 f=uv-vec2(.78+.08*sin(t*.7),.72+.05*cos(t*.9));float glow=.055/(dot(f,f)+.015);vec2 g=uv-vec2(.39,.38);float orb=.018/(dot(g,g)+.025);c.rgb+=vec3(1.,.62,.25)*glow+vec3(.25,.5,1.)*orb;}',
    ' else if(u_mode==26){vec2 d=vec2(.014,.008)*sin(t*2.2);c=(tex(uv-d*3.)+tex(uv-d*2.)+tex(uv-d)+tex(uv)*2.+tex(uv+d)+tex(uv+d*2.)+tex(uv+d*3.))/8.;}',
    ' else if(u_mode==27){vec2 cell=floor(uv*vec2(16.,26.));vec2 local=fract(uv*vec2(16.,26.))-.5;float seed=hash(cell);float tw=step(.66,seed)*pow(.5+.5*sin(t*9.+seed*40.),3.);float star=max(0.,.065/(abs(local.x)+.022)+.065/(abs(local.y)+.022)-2.7)*tw;float lum=dot(c.rgb,vec3(.299,.587,.114));c.rgb+=vec3(1.,.9,.55)*star*(.35+step(.34,lum));}',
    ' else if(u_mode==28){float r=length(p);float a=atan(p.y,p.x)+.12*sin(t*1.7+r*9.);float rr=r*(1.+.35*r*r)+.018*sin(t*3.+r*28.);uv=.5+vec2(cos(a),sin(a))*rr;c=tex(uv);}',
    ' else if(u_mode==29){float r=length(p);vec2 d=normalize(p+vec2(.0001))*(.008+.025*r);c=vec4(tex(uv+d).r,tex(uv).g,tex(uv-d).b,1.);}',
    ' else if(u_mode==30){vec2 f=uv-vec2(-.08+.12*sin(t*.45),.68+.1*cos(t*.6));float leak=smoothstep(.72,.02,length(f));vec2 f2=uv-vec2(1.08,.25+.12*sin(t*.5));float leak2=smoothstep(.62,.03,length(f2));c.rgb=1.-(1.-c.rgb)*(1.-vec3(1.,.22,.04)*leak*.8)*(1.-vec3(.45,.08,1.)*leak2*.55);}',
    ' else if(u_mode==31){vec2 grid=vec2(16.,28.);vec2 id=floor(uv*grid);float gate=step(.72,hash(vec2(id.y,floor(t*5.))));vec2 q=uv;q.x+=gate*(hash(id+floor(t*4.))-.5)*.18;q.y+=gate*.015;c=tex(q);c.gb=mix(c.gb,tex(q+vec2(.018,0.)).gb,gate*.8);}',
    ' else if(u_mode==32){vec2 g=vec2(9.,16.);vec2 id=floor(uv*g);float pulse=step(.68,hash(id+floor(t*9.)));vec2 q=uv+vec2((hash(id)-.5)*.09*pulse,(hash(id.yx)-.5)*.045*pulse);c=tex(q);c.rgb=mix(c.rgb,c.brg,pulse*.38);}',
    ' else if(u_mode==33){float col=floor(uv.x*34.);float speed=.25+hash(vec2(col,2.))*.8;float trail=fract(uv.y+t*speed+hash(vec2(col,1.)));float rain=smoothstep(.72,1.,trail)*step(.7,hash(vec2(col,floor((uv.y+t*speed)*22.))));float lum=dot(c.rgb,vec3(.299,.587,.114));c.rgb=mix(c.rgb,vec3(.05,lum*1.25+.2,.18),.42);c.rgb+=vec3(.05,1.,.3)*rain*.6;}',
    ' else if(u_mode==34){vec2 d=vec2(.012+.009*sin(t*3.),.004);vec3 a=tex(uv-d*3.).rgb;vec3 b=tex(uv-d*2.).rgb;vec3 e=tex(uv-d).rgb;c.rgb=vec3(a.r,b.g,e.b)*.7+c.rgb*.3;}',
    ' else if(u_mode==35){float z=.025+.018*sin(t*3.);vec4 a=tex(.5+p*(1.-z));vec4 b=tex(.5+p*(1.-z*2.));vec4 d=tex(.5+p*(1.-z*3.));c=c*.48+a*.25+b*.17+d*.1;}',
    ' else if(u_mode==36){float k=.018*(.5+.5*sin(t*2.));c=(tex(uv)+tex(.5+p*(1.-k))+tex(.5+p*(1.-k*2.))+tex(.5+p*(1.-k*3.))+tex(.5+p*(1.-k*4.)))/5.;}',
    ' else if(u_mode==37){float r=length(p);float a=atan(p.y,p.x)+(1.-smoothstep(0.,.7,r))*.85*sin(t*.9);uv=.5+vec2(cos(a),sin(a))*r;c=tex(uv);}',
    ' else if(u_mode==38){float s=.13*sin(t*3.2);uv=.5+vec2(p.x/(1.+s),p.y*(1.+s*.7));c=tex(uv);}',
    ' else if(u_mode==39){vec2 cell=floor(uv*vec2(10.,18.));vec2 n=vec2(hash(cell+floor(t*.8)),hash(cell.yx+floor(t*.8)))-.5;vec2 q=uv+n*.018;c=tex(q);float edge=abs(fract(uv.x*10.)-.5)+abs(fract(uv.y*18.)-.5);c.rgb+=smoothstep(.82,.96,edge)*.08;}',
    ' else if(u_mode==40){float phase=fract(t*1.6);float flash=1.-smoothstep(0.,.13,phase);float z=1.+.22*flash;uv=.5+p/z;c=tex(uv);c.rgb+=flash*.7;}',
    ' else if(u_mode==41){vec2 q=3.5/u_resolution;vec3 b=(tex(uv+q).rgb+tex(uv-q).rgb+tex(uv+vec2(q.x,-q.y)).rgb+tex(uv+vec2(-q.x,q.y)).rgb)*.25;c.rgb=mix(c.rgb,b,.3)+max(b-.55,0.)*.75;c.rgb+=vec3(.06,.025,.09);}',
    ' else if(u_mode==42){float ph=fract(t*1.8);float z=1.+.075*sin(ph*6.28318);uv=.5+p/z;c=tex(uv);}',
    ' else if(u_mode==43){vec2 lc=vec2(.5+.18*sin(t*.7),.52+.12*cos(t*.9));vec2 lp=uv-lc;float inside=1.-step(.23,length(lp));vec2 q=lc+lp/(1.+.7*inside);c=mix(c,tex(q),inside);c.rgb+=vec3(.12)*smoothstep(.012,0.,abs(length(lp)-.23));}',
    ' else if(u_mode==44){vec2 q=7./u_resolution;c=(tex(uv)*4.+tex(uv+vec2(q.x,0.))+tex(uv-vec2(q.x,0.))+tex(uv+vec2(0.,q.y))+tex(uv-vec2(0.,q.y))+tex(uv+q)+tex(uv-q)+tex(uv+vec2(q.x,-q.y))+tex(uv+vec2(-q.x,q.y)))/12.;}',
    ' else if(u_mode==45){float a=.027*sin(t*4.2)+.013*sin(t*7.7);vec2 j=vec2(.018*sin(t*5.1),.014*cos(t*4.4));mat2 r=mat2(cos(a),-sin(a),sin(a),cos(a));vec2 q=.5+r*(p*.985)+j;if(q.x<0.||q.x>1.||q.y<0.||q.y>1.)c=vec4(0.,0.,0.,1.);else c=tex(q);}',
    ' else if(u_mode==46){vec2 d=vec2(.018*sin(t*1.6),.012*cos(t*1.3));c=tex(uv)*.48+tex(uv-d)*.28+tex(uv-d*2.)*.16+tex(uv-d*3.)*.08;}',
    ' else if(u_mode==47){float k=floor(t*14.);vec2 j=(vec2(hash(vec2(k,2.)),hash(vec2(k,8.)))-.5)*.085;uv+=j;c=tex(uv);}',
    ' else if(u_mode==48){float z=.035+.014*sin(t*2.);vec2 q1=.5+p*(1.-z);vec2 q2=.5+p*(1.-z*2.);c=vec4(tex(q1).r,tex(uv).g,tex(q2).b,1.);c.rgb=mix(c.rgb,tex(q2).rgb,.22);}',
    ' else if(u_mode==49){vec2 j=vec2(sin(t*15.),cos(t*17.))*.012;uv+=j;c=tex(uv);}',
    ' else if(u_mode==50){vec2 px=1.5/u_resolution;vec3 gx=tex(uv+vec2(px.x,0.)).rgb-tex(uv-vec2(px.x,0.)).rgb;vec3 gy=tex(uv+vec2(0.,px.y)).rgb-tex(uv-vec2(0.,px.y)).rgb;float e=length(gx)+length(gy);vec3 neon=.5+.5*cos(vec3(0.,2.,4.)+t+uv.xyx*5.);c.rgb=c.rgb*.3+neon*e*3.;}',
    ' else if(u_mode==51){float b=abs(sin(t*3.2));float z=1.+.1*b;uv=.5+vec2(p.x,p.y+.035*b)/z;c=tex(uv);}',
    ' else if(u_mode==52){vec2 j=vec2(sin(t*38.)+sin(t*61.),cos(t*43.)+cos(t*57.))*.006;uv+=j;c=tex(uv);}',
    ' else if(u_mode==53){float f=step(.2,fract(t*1.7));c.rgb*=f;}',
    ' else if(u_mode==54){float k=floor(t*18.);vec2 j=(vec2(hash(vec2(k,5.)),hash(vec2(k,9.)))-.5)*.075;float a=(hash(vec2(k,13.))-.5)*.035;mat2 r=mat2(cos(a),-sin(a),sin(a),cos(a));c=tex(.5+r*(p*.97)+j);}',
    ' else if(u_mode==55){c=tex(uv);}',
    ' else if(u_mode==56){c=tex(uv);}',
    ' else if(u_mode==57){float ang=atan(p.y,p.x);float rr=length(p);float spin=smoothstep(.025,0.,abs(rr-.18))*step(0.,sin(ang*10.-t*5.));c.rgb*=.72;c.rgb+=vec3(.2,.8,1.)*spin;float bar=smoothstep(.018,0.,abs(p.y+.27))*step(abs(p.x),.28);c.rgb+=vec3(.95)*bar;}',
    ' else if(u_mode==58){c=tex(uv);}',
    ' else if(u_mode==59){c=tex(uv);}',
    ' else if(u_mode==60){vec2 grid=vec2(16.,28.);vec2 id=floor(uv*grid);vec2 q=fract(uv*grid)-.5;float seed=hash(id);float y=fract(q.y+t*(.3+seed));float dotp=smoothstep(.13,0.,length(vec2(q.x,y-.5)))*step(.62,seed);c.rgb+=dotp*(.5+.5*cos(vec3(0.,2.,4.)+seed*8.+t));}',
    ' else if(u_mode==61){vec2 q=p*3.;float ring=smoothstep(.12,.08,abs(length(q-vec2(0.,.16))-.42))*step(-.05,q.y);float stem=smoothstep(.08,.03,abs(q.x))*step(-.25,q.y)*step(q.y,.12);float dotq=smoothstep(.09,.035,length(q-vec2(0.,-.38)));c.rgb=mix(c.rgb,vec3(1.,.2,.65),clamp(ring+stem+dotq,0.,1.));}',
    ' else if(u_mode==62){c=tex(uv);}',
    ' else if(u_mode==63){float ph=clamp(mod(t,3.5)/3.25,0.,1.);float off=smoothstep(.03,.92,ph);c.rgb*=1.-off*.76;}',
    ' else if(u_mode==64){float ph=mod(t,3.55)/3.55;float env=smoothstep(0.,.09,ph)*(1.-smoothstep(.72,.96,ph));c.rgb=mix(c.rgb,c.rgb*vec3(1.32,.34,.26)+vec3(.12,0.,0.),env*.5);}',
    ' else if(u_mode==65){float ph=fract(t*.22);float z=1.+ph*.78;uv=.5+p/z;c=tex(uv);}',
    ' else if(u_mode==66){float squareH=min(.92,u_resolution.x/u_resolution.y*.98);float top=.5+squareH*.5;float bottom=.5-squareH*.5;if(uv.y<bottom||uv.y>top)c=vec4(0.,0.,0.,1.);else{vec2 local=vec2(uv.x,(uv.y-bottom)/squareH)-.5;vec2 fs=max(u_face.zw,vec2(.01));vec2 q=u_face.xy+local*vec2(fs.x*1.34,fs.y*1.48);c=tex(q);}}',
    ' else if(u_mode==67){c=tex(uv);}',
    ' else if(u_mode==68){vec2 hp=(uv-(u_face.xy+vec2(0.,u_face.w*.64)))/vec2(max(u_face.z,.01),max(u_face.w,.01));float halo=smoothstep(.045,.018,abs(length(hp*vec2(1.,2.8))-.46));c.rgb+=vec3(1.,.78,.18)*halo*1.6;}',
    ' else if(u_mode==69){vec2 fp=(uv-u_face.xy)/max(u_face.zw,vec2(.001));float r=length(fp);float mask=1.-smoothstep(.45,.56,r);vec2 q=u_face.xy+(uv-u_face.xy)*(1.-.62*mask*(1.-r));c=mix(c,tex(q),mask);}',
    ' else if(u_mode==71){c.rgb=mix(c.rgb,c.rgb*vec3(.55,.48,.82),.48);}',
    ' else if(u_mode==72){vec2 fp=(uv-u_face.xy)/max(u_face.zw,vec2(.001));float cheek1=smoothstep(.14,.02,length((fp-vec2(-.23,-.08))*vec2(1.,2.)));float cheek2=smoothstep(.14,.02,length((fp-vec2(.23,-.08))*vec2(1.,2.)));c.rgb=mix(c.rgb,vec3(1.,.18,.42),max(cheek1,cheek2)*.55);}',
    ' else if(u_mode==73){float tw=max(.004,u_face.z*.018);float len=max(.06,u_face.w*.31);float range1=step(u_eyes.y-len,uv.y)*step(uv.y,u_eyes.y-.018);float range2=step(u_eyes.w-len,uv.y)*step(uv.y,u_eyes.w-.018);float outer1=(1.-smoothstep(tw,tw*2.5,abs(uv.x-u_eyes.x)))*range1;float outer2=(1.-smoothstep(tw,tw*2.5,abs(uv.x-u_eyes.z)))*range2;float core1=(1.-smoothstep(tw*.28,tw*.8,abs(uv.x-u_eyes.x)))*range1;float core2=(1.-smoothstep(tw*.28,tw*.8,abs(uv.x-u_eyes.z)))*range2;float tears=max(outer1,outer2);float cores=max(core1,core2);c.rgb=mix(c.rgb,vec3(.05,.62,1.),tears*.85);c.rgb=mix(c.rgb,vec3(1.),cores*.92);}',
    ' else if(u_mode==74){vec2 fp=(uv-u_face.xy)/max(u_face.zw,vec2(.001));float mask=step(abs(fp.x),.5)*step(abs(fp.y),.58);vec2 size=vec2(24.,34.);vec2 q=(floor(uv*size)+.5)/size;c=mix(c,tex(q),mask);}',
    ' gl_FragColor=vec4(clamp(c.rgb,0.,1.),1.);',
    '}'
  ].join('\n');

  function shader(gl, type, source) {
    const item = gl.createShader(type); gl.shaderSource(item, source); gl.compileShader(item);
    if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(item) || 'Effect shader failed.');
    return item;
  }
  function drawCenteredWords(context, width, y, words, fontSize) {
    context.save();
    context.font = '900 ' + fontSize + 'px Arial, sans-serif';
    context.textBaseline = 'middle'; context.textAlign = 'left';
    const gap = fontSize * .2;
    const total = words.reduce(function (sum, word) { return sum + context.measureText(word.text).width; }, 0) + gap * Math.max(0, words.length - 1);
    let x = (width - total) / 2;
    context.shadowColor = 'rgba(0,0,0,.7)'; context.shadowBlur = fontSize * .12; context.lineWidth = Math.max(2, fontSize * .08); context.strokeStyle = 'rgba(0,0,0,.65)';
    words.forEach(function (word) {
      context.fillStyle = word.color || '#fff'; context.strokeText(word.text, x, y); context.fillText(word.text, x, y);
      x += context.measureText(word.text).width + gap;
    });
    context.restore();
  }
  function seededNoise(value) { return (Math.sin(value * 127.1 + 311.7) * 43758.5453) % 1; }
  function drawQuickSpeed(context, width, height, time, state) {
    if (!state) return;
    const frame = state.frame, person = state.person;
    if (frame.width !== width || frame.height !== height) { frame.width = person.width = width; frame.height = person.height = height; }
    const frameContext = frame.getContext('2d'); frameContext.setTransform(1, 0, 0, 1, 0, 0); frameContext.globalCompositeOperation = 'source-over'; frameContext.globalAlpha = 1; frameContext.filter = 'none'; frameContext.clearRect(0, 0, width, height); frameContext.drawImage(context.canvas, 0, 0, width, height);
    const scene = Math.floor(time * 1.35) % 6; const phase = (time * 1.35) % 1;
    const palettes = [['#091b3a','#2467a5','#f6b75d'],['#2b1837','#a14170','#ffbe66'],['#071625','#154854','#49b7b0'],['#26130d','#a43d26','#ffc46c'],['#101021','#383b77','#8bbaff'],['#18251c','#4c7c62','#e4b65a']]; const palette = palettes[scene];
    context.save(); context.clearRect(0, 0, width, height); const sky = context.createLinearGradient(0, 0, 0, height); sky.addColorStop(0, palette[0]); sky.addColorStop(.58, palette[1]); sky.addColorStop(1, '#090909'); context.fillStyle = sky; context.fillRect(0, 0, width, height);
    const horizon = height * .47; context.fillStyle = 'rgba(4,7,12,.84)'; for (let building = -2; building < 15; building += 1) { const bw = width * (.07 + Math.abs(seededNoise(building + scene * 9)) * .08); const bh = height * (.13 + Math.abs(seededNoise(building * 3.1 + scene)) * .3); const x = ((building * width * .11 - phase * width * .34) % (width * 1.35)) - width * .15; context.fillRect(x, horizon - bh, bw, bh); context.fillStyle = 'rgba(255,220,145,.45)'; for (let windowIndex = 0; windowIndex < 3; windowIndex += 1) context.fillRect(x + bw * .18, horizon - bh + bh * (.2 + windowIndex * .24), bw * .14, Math.max(1, height * .006)); context.fillStyle = 'rgba(4,7,12,.84)'; }
    context.fillStyle = '#11151c'; context.beginPath(); context.moveTo(width * .1, height); context.lineTo(width * .43, horizon); context.lineTo(width * .57, horizon); context.lineTo(width * .9, height); context.closePath(); context.fill();
    context.globalCompositeOperation = 'screen'; context.strokeStyle = palette[2]; context.lineCap = 'round'; for (let streak = 0; streak < 22; streak += 1) { const seed = Math.abs(seededNoise(streak * 5.7 + scene)); const y = horizon + seed * height * .5; const x = ((seededNoise(streak * 2.2) + phase * 2.4) % 1.4) * width; context.globalAlpha = .18 + seed * .5; context.lineWidth = Math.max(1, width * (.002 + seed * .009)); context.beginPath(); context.moveTo(x - width * (.12 + seed * .3), y); context.lineTo(x + width * .08, y); context.stroke(); }
    const roadGlow = context.createRadialGradient(width / 2, height * .72, 0, width / 2, height * .72, width * .7); roadGlow.addColorStop(0, palette[2] + '77'); roadGlow.addColorStop(1, 'rgba(0,0,0,0)'); context.fillStyle = roadGlow; context.fillRect(0, horizon, width, height - horizon); context.restore();
    if (state.maskReady && state.mask && state.mask.width) {
      const personContext = person.getContext('2d'); personContext.setTransform(1, 0, 0, 1, 0, 0); personContext.globalCompositeOperation = 'source-over'; personContext.filter = 'none'; personContext.globalAlpha = 1; personContext.clearRect(0, 0, width, height); personContext.drawImage(frame, 0, 0, width, height); personContext.globalCompositeOperation = 'destination-in'; personContext.drawImage(state.mask, 0, 0, width, height); personContext.globalCompositeOperation = 'source-over';
      context.drawImage(person, 0, 0, width, height);
    }
    context.save(); context.strokeStyle = 'rgba(255,255,255,.25)'; context.lineWidth = Math.max(1, width * .004); const cx = width * .5, cy = height * .48;
    for (let line = 0; line < 18; line += 1) { const angle = line * Math.PI * 2 / 18 + scene * .19; const inner = Math.min(width, height) * (.28 + phase * .08); const outer = Math.max(width, height) * .8; context.beginPath(); context.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner); context.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer); context.stroke(); }
    context.restore();
  }
  function drawEnergyLines(context, width, height, time) {
    const cx = width * .5, cy = height * .5, outer = Math.hypot(width, height) * .62, innerBase = Math.min(width, height) * .27;
    context.save(); context.fillStyle = '#050505';
    for (let index = 0; index < 58; index += 1) {
      const random = Math.abs(seededNoise(index * 7.31)); const travel = (time * (1.4 + random * 1.8) + random * 5) % 1; const angle = index * Math.PI * 2 / 58 + time * .17 + Math.sin(time * 3.2 + index) * .018;
      const inner = innerBase * (.58 + random * .42 + travel * .72); const spread = .0035 + random * .009;
      context.globalAlpha = .45 + random * .5; context.beginPath(); context.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner); context.lineTo(cx + Math.cos(angle - spread) * outer, cy + Math.sin(angle - spread) * outer); context.lineTo(cx + Math.cos(angle + spread) * outer, cy + Math.sin(angle + spread) * outer); context.closePath(); context.fill();
    }
    context.restore();
  }
  function drawShockwave(context, width, height, time) {
    const phase = (time % 3.55) / 3.55; const envelope = Math.min(1, phase / .09, (1 - phase) / .16); if (envelope <= 0) return;
    context.save(); context.globalCompositeOperation = 'screen'; context.lineCap = 'round'; context.lineJoin = 'round';
    const paths = [
      function (p) { return [p * width, 7 + Math.abs(Math.sin(p * 31 + time * 7)) * height * .055]; },
      function (p) { return [p * width, height - 7 - Math.abs(Math.sin(p * 29 - time * 6)) * height * .055]; },
      function (p) { return [7 + Math.abs(Math.sin(p * 27 + time * 8)) * width * .07, p * height]; },
      function (p) { return [width - 7 - Math.abs(Math.sin(p * 33 - time * 7)) * width * .07, p * height]; }
    ];
    paths.forEach(function (pointAt, side) { for (let layer = 0; layer < 3; layer += 1) { context.beginPath(); for (let step = 0; step <= 24; step += 1) { const p = step / 24; const point = pointAt(p); const jitter = Math.sin(step * 8.3 + side * 4.7 + layer + time * 14) * (3 + layer * 2); if (side < 2) point[1] += jitter; else point[0] += jitter; if (!step) context.moveTo(point[0], point[1]); else context.lineTo(point[0], point[1]); } context.globalAlpha = envelope * (.95 - layer * .2); context.strokeStyle = layer === 0 ? '#ff1000' : (layer === 1 ? '#ff542e' : '#ffd1bd'); context.lineWidth = Math.max(2, width * (.014 - layer * .003)); context.shadowColor = '#ff1000'; context.shadowBlur = width * .035; context.stroke(); } });
    if (phase < .18) { const flash = 1 - phase / .18; const gradient = context.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * .7); gradient.addColorStop(0, 'rgba(255,255,255,' + (.52 * flash) + ')'); gradient.addColorStop(.25, 'rgba(255,55,28,' + (.42 * flash) + ')'); gradient.addColorStop(1, 'rgba(255,0,0,0)'); context.fillStyle = gradient; context.fillRect(0, 0, width, height); }
    context.restore();
  }
  function trackedFeatures(state, width, height) {
    const face = state && state.face || [.5, .58, .38, .48];
    const eyes = state && state.eyes || [.43, .62, .57, .62];
    return {
      faceX: face[0] * width,
      faceY: (1 - face[1]) * height,
      faceWidth: face[2] * width,
      faceHeight: face[3] * height,
      eyes: [[eyes[0] * width, (1 - eyes[1]) * height], [eyes[2] * width, (1 - eyes[3]) * height]]
    };
  }
  function drawSoul(context, width, height, time, state) {
    if (!state) return;
    const frame = state.frame, person = state.person;
    if (frame.width !== width || frame.height !== height) { frame.width = person.width = width; frame.height = person.height = height; }
    const frameContext = frame.getContext('2d'); frameContext.setTransform(1, 0, 0, 1, 0, 0); frameContext.globalCompositeOperation = 'source-over'; frameContext.globalAlpha = 1; frameContext.filter = 'none'; frameContext.clearRect(0, 0, width, height); frameContext.drawImage(context.canvas, 0, 0, width, height);
    const personContext = person.getContext('2d'); personContext.setTransform(1, 0, 0, 1, 0, 0); personContext.globalCompositeOperation = 'source-over'; personContext.globalAlpha = 1; personContext.filter = 'none'; personContext.clearRect(0, 0, width, height); personContext.drawImage(frame, 0, 0, width, height);
    if (state.maskReady && state.mask && state.mask.width) { personContext.globalCompositeOperation = 'destination-in'; personContext.drawImage(state.mask, 0, 0, width, height); personContext.globalCompositeOperation = 'source-over'; }
    const phase = (time % 1.9) / 1.9; const eased = 1 - Math.pow(1 - phase, 2); const scale = 1 + eased * .16;
    context.save(); context.globalCompositeOperation = 'screen'; context.globalAlpha = Math.max(0, .58 * (1 - phase)); context.filter = 'grayscale(0.35) brightness(1.38) blur(' + Math.max(1, width * .004 * eased) + 'px)'; context.translate(width * .5, height * .5 - height * .13 * eased); context.scale(scale, scale); context.drawImage(person, -width / 2, -height / 2, width, height); context.restore();
  }
  function drawBlackGlasses(context, width, height, state) {
    const tracked = trackedFeatures(state, width, height); const left = tracked.eyes[0], right = tracked.eyes[1]; const span = Math.max(18, Math.abs(right[0] - left[0])); const lensWidth = span * .92; const lensHeight = Math.max(8, tracked.faceHeight * .105); const line = Math.max(2, tracked.faceWidth * .035);
    context.save(); context.lineCap = 'round'; context.lineJoin = 'round'; context.strokeStyle = '#050505'; context.lineWidth = line; context.shadowColor = 'rgba(0,0,0,.55)'; context.shadowBlur = line * 1.5;
    context.beginPath(); context.moveTo(left[0] - lensWidth * .48, left[1]); context.lineTo(left[0] - tracked.faceWidth * .62, left[1] - lensHeight * .12); context.moveTo(right[0] + lensWidth * .48, right[1]); context.lineTo(right[0] + tracked.faceWidth * .62, right[1] - lensHeight * .12); context.moveTo(left[0] + lensWidth * .48, left[1]); context.quadraticCurveTo((left[0] + right[0]) / 2, Math.min(left[1], right[1]) - lensHeight * .18, right[0] - lensWidth * .48, right[1]); context.stroke();
    [left, right].forEach(function (eye) { const gradient = context.createLinearGradient(eye[0], eye[1] - lensHeight / 2, eye[0], eye[1] + lensHeight / 2); gradient.addColorStop(0, '#090909'); gradient.addColorStop(.58, '#020202'); gradient.addColorStop(1, '#171717'); context.fillStyle = gradient; context.beginPath(); context.moveTo(eye[0] - lensWidth * .5, eye[1] - lensHeight * .38); context.quadraticCurveTo(eye[0], eye[1] - lensHeight * .62, eye[0] + lensWidth * .5, eye[1] - lensHeight * .38); context.lineTo(eye[0] + lensWidth * .42, eye[1] + lensHeight * .38); context.quadraticCurveTo(eye[0], eye[1] + lensHeight * .58, eye[0] - lensWidth * .42, eye[1] + lensHeight * .38); context.closePath(); context.fill(); context.stroke(); context.strokeStyle = 'rgba(255,255,255,.18)'; context.lineWidth = Math.max(1, line * .18); context.beginPath(); context.moveTo(eye[0] - lensWidth * .3, eye[1] - lensHeight * .28); context.lineTo(eye[0] + lensWidth * .08, eye[1] - lensHeight * .4); context.stroke(); context.strokeStyle = '#050505'; context.lineWidth = line; });
    context.restore();
  }
  function drawLaserEyes(context, width, height, time, state) {
    const tracked = trackedFeatures(state, width, height); const pulse = .9 + .1 * Math.sin(time * 15);
    context.save(); context.globalCompositeOperation = 'screen'; context.lineCap = 'round';
    tracked.eyes.forEach(function (eye, index) {
      const endY = eye[1] + (index ? -1 : 1) * height * .012;
      [[.052, .14, '#ff4a00'], [.026, .32, '#ff9b22'], [.009, .94, '#fff7c2']].forEach(function (layer) {
        context.globalAlpha = layer[1] * pulse; context.strokeStyle = layer[2]; context.lineWidth = Math.max(2, width * layer[0]); context.shadowColor = '#ff3b00'; context.shadowBlur = width * .045; context.beginPath(); context.moveTo(eye[0], eye[1]); context.lineTo(-width * .08, endY); context.stroke();
      });
      const glow = context.createRadialGradient(eye[0], eye[1], 0, eye[0], eye[1], width * .055); glow.addColorStop(0, '#fff'); glow.addColorStop(.18, '#ffe676'); glow.addColorStop(.48, 'rgba(255,74,0,.9)'); glow.addColorStop(1, 'rgba(255,20,0,0)'); context.globalAlpha = 1; context.fillStyle = glow; context.fillRect(eye[0] - width * .06, eye[1] - width * .06, width * .12, width * .12);
    });
    context.restore();
  }
  function heartPath(context, x, y, size) {
    context.beginPath(); context.moveTo(x, y + size * .3); context.bezierCurveTo(x - size * .75, y - size * .18, x - size * .48, y - size * .72, x, y - size * .36); context.bezierCurveTo(x + size * .48, y - size * .72, x + size * .75, y - size * .18, x, y + size * .3); context.closePath();
  }
  function drawShy(context, width, height, time, state) {
    const tracked = trackedFeatures(state, width, height); const fw = tracked.faceWidth, fh = tracked.faceHeight; const cheekY = tracked.faceY + fh * .13;
    context.save(); context.globalCompositeOperation = 'source-over';
    [-1, 1].forEach(function (side) {
      const x = tracked.faceX + side * fw * .25; const blush = context.createRadialGradient(x, cheekY, 0, x, cheekY, fw * .14); blush.addColorStop(0, 'rgba(255,45,79,.78)'); blush.addColorStop(1, 'rgba(255,45,79,0)'); context.fillStyle = blush; context.fillRect(x - fw * .16, cheekY - fh * .09, fw * .32, fh * .18);
      context.strokeStyle = 'rgba(255,190,202,.9)'; context.lineWidth = Math.max(1.4, width * .003); for (let line = -1; line <= 1; line += 1) { context.beginPath(); context.moveTo(x + line * fw * .055 - fw * .025, cheekY - fh * .025); context.lineTo(x + line * fw * .055 + fw * .018, cheekY + fh * .018); context.stroke(); }
      context.save(); context.translate(x + side * fw * .22, tracked.faceY + fh * .03); context.rotate(side * -.18); context.fillStyle = '#ff2f50'; context.font = '800 ' + Math.max(9, fw * .08) + 'px Arial'; context.fillText('oh!', 0, 0); context.restore();
    });
    const hearts = [[-.58,-.56,.13],[.58,-.48,.11],[-.68,.06,.08],[.68,.13,.1],[.1,-.72,.07]];
    hearts.forEach(function (heart, index) { const bob = Math.sin(time * 2.7 + index * 1.4) * fh * .025; const x = tracked.faceX + heart[0] * fw; const y = tracked.faceY + heart[1] * fh + bob; const size = fw * heart[2]; context.fillStyle = index % 2 ? '#ff3155' : '#ef153c'; context.shadowColor = 'rgba(255,30,65,.6)'; context.shadowBlur = size * .5; heartPath(context, x, y, size); context.fill(); });
    context.restore();
  }
  function drawFancyOverlay(context, width, height, effectId, time, state) {
    const t = Math.max(0, Number(time) || 0);
    if (effectId === 'disco-count') {
      const count = 10 - (Math.floor((t % 5) * 2) % 10);
      const phase = (t * 2) % 1;
      context.save(); context.translate(width / 2, height * .15); context.rotate(Math.sin(t * 5) * .04); context.scale(1.15 - phase * .15, 1.15 - phase * .15);
      const size = Math.max(42, height * .14); context.font = '900 ' + size + 'px Arial Black, Arial, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
      const gradient = context.createLinearGradient(0, -size / 2, 0, size / 2); gradient.addColorStop(0, '#fff'); gradient.addColorStop(.28, '#777'); gradient.addColorStop(.48, '#f5f5f5'); gradient.addColorStop(.72, '#555'); gradient.addColorStop(1, '#ddd');
      context.lineWidth = Math.max(3, size * .07); context.strokeStyle = 'rgba(30,30,30,.75)'; context.shadowColor = 'rgba(0,0,0,.65)'; context.shadowBlur = size * .12; context.strokeText(String(count), 0, 0); context.fillStyle = gradient; context.fillText(String(count), 0, 0); context.restore();
    } else if (effectId === 'lyric-cut') {
      const phrases = [
        [{ text: 'NEW', color: '#ffe733' }, { text: 'LIFE' }],
        [{ text: 'BEST', color: '#8cff45' }, { text: 'LIFE' }],
        [{ text: 'JUST' }, { text: 'GOTTA', color: '#ffe733' }],
        [{ text: 'LET', color: '#62f5bb' }, { text: 'IT GO' }],
        [{ text: 'YOU', color: '#ff719e' }, { text: 'ONLY' }],
        [{ text: 'LIVE', color: '#76ecff' }, { text: 'ONCE' }]
      ];
      const index = Math.floor(t * 1.45) % phrases.length;
      const phase = (t * 1.45) % 1;
      context.save(); context.globalAlpha = Math.min(1, phase * 7, (1 - phase) * 7); context.translate(0, Math.sin(phase * Math.PI) * -height * .012);
      drawCenteredWords(context, width, height * .53, phrases[index], Math.max(18, height * .047)); context.restore();
    } else if (effectId === 'soul') drawSoul(context, width, height, t, state);
    else if (effectId === 'quick-speed') drawQuickSpeed(context, width, height, t, state);
    else if (effectId === 'energy') drawEnergyLines(context, width, height, t);
    else if (effectId === 'moon-off') {
      const phase = Math.min(1, (t % 3.5) / 3.25); const x = width * .16; const top = height * .42; const bottom = height * .61; const boxWidth = width * .12; const radius = Math.max(7, width * .035); const y = top + (bottom - top) * phase;
      context.save(); context.strokeStyle = '#f8d338'; context.lineWidth = Math.max(2, width * .004); context.strokeRect(x - boxWidth / 2, top - radius * 1.55, boxWidth, bottom - top + radius * 3.1); context.beginPath(); context.moveTo(x - boxWidth / 2, bottom + radius * 2.1); context.lineTo(x - boxWidth / 2, top - radius * 1.55); context.stroke();
      if (phase < .48) { context.fillStyle = '#ffcf24'; context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill(); for (let index = 0; index < 8; index += 1) { const a = index * Math.PI / 4; context.beginPath(); context.moveTo(x + Math.cos(a) * radius * 1.3, y + Math.sin(a) * radius * 1.3); context.lineTo(x + Math.cos(a) * radius * 1.7, y + Math.sin(a) * radius * 1.7); context.stroke(); } }
      else { context.fillStyle = '#f4f3e9'; context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill(); context.fillStyle = 'rgba(42,42,46,.9)'; context.beginPath(); context.arc(x + radius * .4, y - radius * .2, radius * .84, 0, Math.PI * 2); context.fill(); }
      const sx = x - boxWidth / 2, sy = bottom + radius * 2.1; context.fillStyle = '#f8d338'; context.beginPath(); context.arc(sx, sy, radius * .27, 0, Math.PI * 2); context.fill(); for (let index = 0; index < 8; index += 1) { const a = index * Math.PI / 4; context.beginPath(); context.moveTo(sx + Math.cos(a) * radius * .42, sy + Math.sin(a) * radius * .42); context.lineTo(sx + Math.cos(a) * radius * .72, sy + Math.sin(a) * radius * .72); context.stroke(); } context.restore();
    } else if (effectId === 'shockwave') drawShockwave(context, width, height, t);
    else if (effectId === 'black-glasses') drawBlackGlasses(context, width, height, state);
    else if (effectId === 'laser-eyes') drawLaserEyes(context, width, height, t, state);
    else if (effectId === 'shy') drawShy(context, width, height, t, state);
  }
  function createRenderer(canvas, options) {
    options = options || {};
    const renderCanvas = document.createElement('canvas');
    const gl = renderCanvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    const outputContext = canvas.getContext('2d', { alpha: false });
    if (!gl || !outputContext) return null;
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, shader(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Effect program failed.');
    gl.useProgram(program);
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position'); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const timeLocation = gl.getUniformLocation(program, 'u_time');
    const modeLocation = gl.getUniformLocation(program, 'u_mode');
    const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
    const faceLocation = gl.getUniformLocation(program, 'u_face');
    const eyesLocation = gl.getUniformLocation(program, 'u_eyes');
    let face = [.5, .58, .38, .48];
    let eyes = [.43, .62, .57, .62];
    let faceDetector = null, faceMesh = null, faceMeshFailed = false, faceDetectionBusy = false, lastFaceDetection = 0;
    const fancyState = { frame: document.createElement('canvas'), person: document.createElement('canvas'), mask: document.createElement('canvas'), maskReady: false };
    let segmenter = null, segmentationFailed = false, segmentationBusy = false, lastSegmentation = 0, segmentationWidth = 0, segmentationHeight = 0;
    try { if ('FaceDetector' in window) faceDetector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 }); } catch (_error) { faceDetector = null; }
    function smoothValues(current, next) { return current.map(function (value, index) { return value * .58 + next[index] * .42; }); }
    function ensureFaceMesh() {
      if (faceMesh || faceMeshFailed || !window.FaceMesh) return faceMesh;
      try {
        faceMesh = new window.FaceMesh({ locateFile: function (file) { return '/mediapipe/' + file; } });
        faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: .5, minTrackingConfidence: .5 });
        faceMesh.onResults(function (results) {
          const points = results && results.multiFaceLandmarks && results.multiFaceLandmarks[0];
          if (!points || !points.length) return;
          let minX = 1, minY = 1, maxX = 0, maxY = 0;
          points.slice(0, 468).forEach(function (point) { minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y); });
          face = smoothValues(face, [(minX + maxX) / 2, 1 - (minY + maxY) / 2, Math.max(.01, maxX - minX), Math.max(.01, maxY - minY)]);
          const left = points[468] || { x: (points[33].x + points[133].x) / 2, y: (points[33].y + points[133].y) / 2 };
          const right = points[473] || { x: (points[362].x + points[263].x) / 2, y: (points[362].y + points[263].y) / 2 };
          eyes = smoothValues(eyes, [left.x, 1 - left.y, right.x, 1 - right.y]);
        });
      } catch (_error) { faceMeshFailed = true; faceMesh = null; }
      return faceMesh;
    }
    function updateTrackedFace(source, width, height, mode) {
      if (options.trackFace === false || mode < 66 || faceDetectionBusy || performance.now() - lastFaceDetection < 120) return;
      faceDetectionBusy = true; lastFaceDetection = performance.now();
      const mesh = ensureFaceMesh();
      if (mesh) {
        mesh.send({ image: source }).catch(function () { faceMeshFailed = true; faceMesh = null; }).finally(function () { faceDetectionBusy = false; });
        return;
      }
      if (!faceDetector) { faceDetectionBusy = false; return; }
      faceDetector.detect(source).then(function (faces) {
        const box = faces && faces[0] && faces[0].boundingBox;
        if (!box) return;
        const x = Number(box.x != null ? box.x : box.left) || 0;
        const y = Number(box.y != null ? box.y : box.top) || 0;
        const w = Math.max(1, Number(box.width) || 1), h = Math.max(1, Number(box.height) || 1);
        const next = [(x + w / 2) / width, 1 - (y + h / 2) / height, w / width, h / height];
        face = smoothValues(face, next);
        eyes = smoothValues(eyes, [next[0] - next[2] * .18, next[1] + next[3] * .08, next[0] + next[2] * .18, next[1] + next[3] * .08]);
      }).catch(function () {}).finally(function () { faceDetectionBusy = false; });
    }
    function ensureSegmenter() {
      if (segmenter || segmentationFailed || !window.SelfieSegmentation) return segmenter;
      try {
        segmenter = new window.SelfieSegmentation({ locateFile: function (file) { return '/segmentation/' + file; } });
        segmenter.setOptions({ modelSelection: 1, selfieMode: false });
        segmenter.onResults(function (results) {
          if (!results || !results.segmentationMask || !segmentationWidth || !segmentationHeight) return;
          if (fancyState.mask.width !== segmentationWidth || fancyState.mask.height !== segmentationHeight) { fancyState.mask.width = segmentationWidth; fancyState.mask.height = segmentationHeight; }
          const maskContext = fancyState.mask.getContext('2d'); maskContext.clearRect(0, 0, segmentationWidth, segmentationHeight); maskContext.drawImage(results.segmentationMask, 0, 0, segmentationWidth, segmentationHeight);
          fancyState.maskReady = true;
        });
      } catch (_error) { segmentationFailed = true; segmenter = null; }
      return segmenter;
    }
    function updateSegmentation(source, width, height, mode) {
      if (options.trackFace === false || (mode !== 55 && mode !== 59) || segmentationBusy || performance.now() - lastSegmentation < 90) return;
      const activeSegmenter = ensureSegmenter(); if (!activeSegmenter) return;
      segmentationBusy = true; lastSegmentation = performance.now(); segmentationWidth = width; segmentationHeight = height;
      activeSegmenter.send({ image: source }).catch(function () { segmentationFailed = true; segmenter = null; }).finally(function () { segmentationBusy = false; });
    }
    return {
      render: function (source, effectId, time) {
        if (!source || !source.width && !source.videoWidth) return false;
        const width = source.videoWidth || source.width, height = source.videoHeight || source.height;
        if (!width || !height) return false;
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        if (renderCanvas.width !== width || renderCanvas.height !== height) { renderCanvas.width = width; renderCanvas.height = height; }
        gl.viewport(0, 0, renderCanvas.width, renderCanvas.height); gl.useProgram(program); gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); } catch (_error) { return false; }
        const mode = modes[effectId] || 0;
        updateTrackedFace(source, width, height, mode);
        updateSegmentation(source, width, height, mode);
        gl.uniform1f(timeLocation, Number(time) || 0); gl.uniform1i(modeLocation, mode); gl.uniform2f(resolutionLocation, renderCanvas.width, renderCanvas.height);
        gl.uniform4f(faceLocation, face[0], face[1], face[2], face[3]);
        gl.uniform4f(eyesLocation, eyes[0], eyes[1], eyes[2], eyes[3]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        outputContext.setTransform(1, 0, 0, 1, 0, 0); outputContext.globalAlpha = 1; outputContext.filter = 'none'; outputContext.clearRect(0, 0, width, height); outputContext.drawImage(renderCanvas, 0, 0, width, height);
        fancyState.face = face.slice(); fancyState.eyes = eyes.slice();
        drawFancyOverlay(outputContext, width, height, effectId, time, fancyState); return true;
      }
    };
  }
  window.ReelEffects = { catalog: catalog, modes: modes, createRenderer: createRenderer };
})();
