
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexPath = Join-Path $project "index.html"

if (!(Test-Path $indexPath)) {
  Write-Host "ERROR: index.html not found." -ForegroundColor Red
  Write-Host "Copy this patch into the alldaypick-order-alert folder first."
  Read-Host "Press Enter"
  exit 1
}

$html = Get-Content -Raw -Encoding UTF8 $indexPath

if ($html -match 'id="pushRegisterCard"') {
  Write-Host "v16 push registration UI is already installed." -ForegroundColor Yellow
  Read-Host "Press Enter"
  exit 0
}

$pushCard = @'
  <section class="card section" id="pushRegisterCard">
    <div class="section-head">
      <h2>휴대폰 푸시 등록</h2>
      <span style="color:var(--muted);font-size:12px">휴대폰마다 1회 등록</span>
    </div>

    <div class="form">
      <label>
        VAPID 공개키
        <input
          id="vapidKeyInput"
          type="text"
          placeholder="Firebase에서 복사한 B로 시작하는 긴 공개키"
          autocomplete="off"
        >
      </label>

      <button class="btn primary" id="registerPhonePushBtn" type="button">
        이 휴대폰 푸시 등록
      </button>

      <button class="btn" id="testPhoneNotificationBtn" type="button">
        이 휴대폰 알림 테스트
      </button>

      <div id="phonePushStatus" style="font-size:12px;color:var(--muted)">
        아직 등록되지 않았습니다.
      </div>
    </div>
  </section>
'@

$insertPoint = '<div id="statsPanel" class="stats-panel">'
if ($html.Contains($insertPoint)) {
  $html = $html.Replace($insertPoint, $pushCard + "`r`n  " + $insertPoint)
} else {
  $html = $html.Replace('</main>', $pushCard + "`r`n</main>")
}

$pushScript = @'
const PHONE_PUSH_VAPID_KEY='alldaypick_phone_vapid_key';

function setPhonePushStatus(text,state=''){
  const el=$('phonePushStatus');
  if(!el) return;
  el.textContent=text;
  el.style.color=
    state==='success' ? '#059669' :
    state==='error' ? '#dc2626' :
    state==='running' ? '#2563eb' :
    'var(--muted)';
}

async function registerThisPhoneForPush(){
  const vapidKey=$('vapidKeyInput').value.trim();

  if(!vapidKey){
    setPhonePushStatus('VAPID 공개키를 입력하세요.','error');
    return;
  }

  if(!('Notification' in window)){
    setPhonePushStatus('이 브라우저는 알림을 지원하지 않습니다.','error');
    return;
  }

  if(!('serviceWorker' in navigator)){
    setPhonePushStatus('이 브라우저는 백그라운드 푸시를 지원하지 않습니다.','error');
    return;
  }

  if(!messaging){
    setPhonePushStatus('Firebase Messaging을 사용할 수 없습니다.','error');
    return;
  }

  if(!currentUser){
    setPhonePushStatus('클라우드 연결 후 다시 시도하세요.','error');
    return;
  }

  localStorage.setItem(PHONE_PUSH_VAPID_KEY,vapidKey);
  setPhonePushStatus('알림 권한을 확인하는 중','running');

  try{
    const permission=await Notification.requestPermission();

    if(permission!=='granted'){
      throw new Error('알림 권한이 허용되지 않았습니다.');
    }

    setPhonePushStatus('푸시 토큰을 발급하는 중','running');

    const registration=await navigator.serviceWorker.register('./sw.js');

    await navigator.serviceWorker.ready;

    const token=await messaging.getToken({
      vapidKey,
      serviceWorkerRegistration:registration
    });

    if(!token){
      throw new Error('푸시 토큰을 발급받지 못했습니다.');
    }

    await db.collection('devices').doc(token).set({
      token,
      enabled:true,
      userId:currentUser.uid,
      platform:navigator.platform||'unknown',
      userAgent:navigator.userAgent,
      site:'github-pages',
      registeredAt:firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt:firebase.firestore.FieldValue.serverTimestamp()
    },{merge:true});

    setPhonePushStatus('이 휴대폰 푸시 등록 완료','success');
    toast('휴대폰 푸시 등록이 완료되었습니다.');
  }catch(error){
    console.error(error);
    setPhonePushStatus('등록 실패: '+error.message,'error');
  }
}

async function testThisPhoneNotification(){
  try{
    if(Notification.permission!=='granted'){
      const permission=await Notification.requestPermission();
      if(permission!=='granted'){
        throw new Error('알림 권한이 허용되지 않았습니다.');
      }
    }

    const registration=await navigator.serviceWorker.ready;

    await registration.showNotification('올데이픽 알림 테스트',{
      body:'이 휴대폰 알림이 정상적으로 작동합니다.',
      icon:'./icon.svg',
      badge:'./icon.svg',
      tag:'alldaypick-test',
      renotify:true,
      vibrate:[200,100,200],
      data:{
        url:'https://jae-dong.github.io/alldaypick-order-alert/'
      }
    });

    setPhonePushStatus('테스트 알림을 보냈습니다.','success');
  }catch(error){
    setPhonePushStatus('테스트 실패: '+error.message,'error');
  }
}

window.addEventListener('load',()=>{
  const savedVapid=localStorage.getItem(PHONE_PUSH_VAPID_KEY)||'';

  if($('vapidKeyInput')){
    $('vapidKeyInput').value=savedVapid;
  }

  if($('registerPhonePushBtn')){
    $('registerPhonePushBtn').onclick=registerThisPhoneForPush;
  }

  if($('testPhoneNotificationBtn')){
    $('testPhoneNotificationBtn').onclick=testThisPhoneNotification;
  }

  if(Notification.permission==='granted'){
    setPhonePushStatus('알림 권한 허용됨 · 휴대폰 등록 버튼을 눌러주세요.');
  }
});
'@

$scriptInsert = 'initCloud();'
if ($html.Contains($scriptInsert)) {
  $html = $html.Replace($scriptInsert, $pushScript + "`r`n" + $scriptInsert)
} else {
  $html = $html.Replace('</script>', $pushScript + "`r`n</script>")
}

$html = $html.Replace('order-alert-v15','order-alert-v16')
$html = $html.Replace('order-alert-v14','order-alert-v16')

Set-Content -Path $indexPath -Value $html -Encoding UTF8

Write-Host ""
Write-Host "SUCCESS: v16 phone push registration UI installed." -ForegroundColor Green
Write-Host "Firebase configuration was preserved." -ForegroundColor Green
Write-Host ""
Write-Host "Next: Commit and Push with GitHub Desktop." -ForegroundColor Cyan
Write-Host ""

Read-Host "Press Enter"
