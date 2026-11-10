import { BROWSER_SHORTCUT_BINDINGS } from "../src/domain/browser-shortcuts";

/** Page context and fixed browser shortcuts cross this channel; no native tools. */
export function browserContextBridge(finalUrl: string): string {
  const safeUrl = JSON.stringify(finalUrl).replace(/</g, "\\u003c");
  const shortcuts = JSON.stringify(BROWSER_SHORTCUT_BINDINGS);
  return `<script data-omnia-context-bridge>(function(){
    var pageUrl=${safeUrl};
    var shortcuts=${shortcuts};
    function send(type,extra){parent.postMessage(Object.assign({channel:"omnia:browser-context",type:type,url:pageUrl,title:document.title},extra||{}),"*");}
    function snapshot(){send("loaded",{html:document.documentElement.outerHTML.slice(0,250000)});}
    window.addEventListener("message",function(event){if(event.source===parent&&event.data&&event.data.channel==="omnia:browser-control"&&event.data.action==="stop")window.stop();});
    document.addEventListener("keydown",function(event){
      if(event.repeat||event.defaultPrevented||event.isComposing||event.keyCode===229)return;
      if(event.target instanceof Element&&event.target.closest('[hidden], [inert], [aria-hidden="true"], [role="dialog"], [role="alertdialog"], dialog[open]'))return;
      var modifiers=(event.ctrlKey?1:0)|(event.metaKey?2:0)|(event.altKey?4:0)|(event.shiftKey?8:0);
      var action=shortcuts[modifiers+":"+event.key.toLowerCase()];
      if(!action)return;
      if(action!=="close-drawers")event.preventDefault();
      send("shortcut",{keyboard:{key:event.key,ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey,shiftKey:event.shiftKey,repeat:event.repeat}});
    });
    document.addEventListener("click",function(event){
      var anchor=event.target instanceof Element?event.target.closest("a[href]"):null;
      if(!anchor||event.defaultPrevented||event.button!==0)return;
      var href=anchor.getAttribute("href");
      if(!href||href[0]==="#"||anchor.hasAttribute("download"))return;
      var target;try{target=new URL(href,pageUrl);}catch(_){return;}
      if(!/^https?:$/.test(target.protocol))return;
      event.preventDefault();
      send("navigate",{url:target.href});
    },true);
    document.addEventListener("submit",function(event){
      var form=event.target;if(!(form instanceof HTMLFormElement)||form.method.toLowerCase()!=="get")return;
      var target;try{target=new URL(form.getAttribute("action")||pageUrl,pageUrl);}catch(_){return;}
      if(!/^https?:$/.test(target.protocol))return;
      new FormData(form).forEach(function(value,key){if(typeof value==="string")target.searchParams.append(key,value);});
      event.preventDefault();send("navigate",{url:target.href});
    },true);
    document.addEventListener("mouseup",function(){var text=String(window.getSelection()||"").trim();if(text)send("selection",{selection:text.slice(0,12000)});});
    window.addEventListener("load",snapshot,{once:true});
    if(document.readyState==="complete")snapshot();
  })();</script>`;
}
