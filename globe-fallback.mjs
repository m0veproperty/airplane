// Applied to the captured globe component during the local replay build.
// Keep the original globe when supported; isolate renderer failures to this section.
export const globeFallback = `
function AeroStaticGlobe(props){
  m.useEffect(function(){
    var timer=setTimeout(function(){window.dispatchEvent(new CustomEvent("globeFullyReady",{detail:{fallback:true,timestamp:Date.now()}}))},300);
    return function(){clearTimeout(timer)};
  },[]);
  return m.default.createElement("div",{
    "data-webgl-fallback":"globe","aria-hidden":"true",
    style:{position:"absolute",inset:0,display:"grid",placeItems:"center",pointerEvents:"none"}
  },m.default.createElement("div",{style:{width:"82%",aspectRatio:"1",borderRadius:"50%",
    backgroundColor:"#b7cce1",backgroundImage:"url("+JSON.stringify(props.earthTextureUrl||props.earthTextureUrlMobile||"/globe/webp/earth-filter.webp")+")",
    backgroundPosition:"center",backgroundSize:"200% 100%",boxShadow:"inset -45px -20px 70px rgba(5,39,91,.5), inset 16px 8px 35px rgba(255,255,255,.4)"}}));
}
class AeroGlobeBoundary extends m.default.Component{
  constructor(props){super(props);this.state={failed:false}}
  static getDerivedStateFromError(){return {failed:true}}
  render(){return this.state.failed?m.default.createElement(AeroStaticGlobe,this.props):this.props.children}
}
function AeroSafeGlobe(props){
  var pair=m.useState(null),supported=pair[0],setSupported=pair[1];
  m.useEffect(function(){
    var canvas=document.createElement("canvas"),gl=null;
    try{gl=canvas.getContext("webgl2");setSupported(!!gl)}catch(error){setSupported(false)}
    finally{if(gl){var extension=gl.getExtension("WEBGL_lose_context");if(extension)extension.loseContext()}}
  },[]);
  if(supported===null)return null;
  return supported?m.default.createElement(AeroGlobeBoundary,props,m.default.createElement(Ys,props)):m.default.createElement(AeroStaticGlobe,props);
}
`;

export function patchGlobe(source) {
  const marker='e.s(["default",()=>Ys],12078)';
  if(source.split(marker).length!==2)throw new Error('Captured globe export changed; review fallback patch before deploying.');
  return source.replace(marker,globeFallback+'e.s(["default",()=>AeroSafeGlobe],12078)');
}
