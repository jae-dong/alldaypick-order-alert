
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

if ($html -notmatch 'PHONE_PUSH_VAPID_KEY') {
  Write-Host "ERROR: v16 push registration code was not found." -ForegroundColor Red
  Write-Host "Apply v16 first, then run this patch."
  Read-Host "Press Enter"
  exit 1
}

if ($html -match 'restorePhonePushRegistration') {
  Write-Host "v17 push restore is already installed." -ForegroundColor Yellow
  Read-Host "Press Enter"
  exit 0
}

$oldBlockPattern = 'window\.addEventListener\(''load'',\(\)=>\{.*?if\(Notification\.permission===''granted''\)\{.*?\}\s*\}\);'

$newBlock = @'
function setPushButtonRegistered(isRegistered){
  const button=$('registerPhonePushBtn');
  if(!button) return;

  if(isRegistered){
    button.textContent='이 휴대폰 등록됨';
    button.disabled=false;
  }else{
    button.textContent='이 휴대폰 푸시 등록';
    button.disabled=false;
  }
}

async function waitForPushCloudReady(timeoutMs=12000){
  const started=Date.now();

  while(Date.now()-started<timeoutMs){
    if(currentUser&&cloudReady&&messaging) return true;
    await new Promise(resolve=>setTimeout(resolve,250));
  }

  return false;
}

async function restorePhonePushRegistration(){
  const savedVapid=localStorage.getItem(PHONE_PUSH_VAPID_KEY)||'';

  if($('vapidKeyInput')){
    $('vapidKeyInput').value=savedVapid;
  }

  if(!savedVapid){
    setPushButtonRegistered(false);
    setPhonePushStatus('VAPID 공개키를 입력하고 휴대폰을 등록하세요.');
    return;
  }

  if(Notification.permission==='denied'){
    setPushButtonRegistered(false);
    setPhonePushStatus('Chrome 알림 권한이 차단되어 있습니다.','error');
    return;
  }

  if(Notification.permission!=='granted'){
    setPushButtonRegistered(false);
    setPhonePushStatus('알림 권한 허용 후 휴대폰을 등록하세요.');
    return;
  }

  setPhonePushStatus('기존 푸시 등록 상태 확인 중','running');

  const ready=await waitForPushCloudReady();

  if(!ready){
    setPushButtonRegistered(false);
    setPhonePushStatus('클라우드 연결 후 다시 확인합니다.','error');
    return;
  }

  try{
    const registration=await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;

    const token=await messaging.getToken({
      vapidKey:savedVapid,
      serviceWorkerRegistration:registration
    });

    if(!token){
      throw new Error('기존 푸시 토큰을 확인하지 못했습니다.');
    }

    const ref=db.collection('devices').doc(token);
    const snapshot=await ref.get();

    if(snapshot.exists&&snapshot.data()?.enabled!==false){
      await ref.set({
        token,
        enabled:true,
        userId:currentUser.uid,
        platform:navigator.platform||'unknown',
        userAgent:navigator.userAgent,
        updatedAt:firebase.firestore.FieldValue.serverTimestamp()
      },{merge:true});

      setPushButtonRegistered(true);
      setPhonePushStatus('이 휴대폰 푸시 등록 완료','success');
      return;
    }

    await ref.set({
      token,
      enabled:true,
      userId:currentUser.uid,
      platform:navigator.platform||'unknown',
      userAgent:navigator.userAgent,
      site:'github-pages',
      registeredAt:firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt:firebase.firestore.FieldValue.serverTimestamp()
    },{merge:true});

    setPushButtonRegistered(true);
    setPhonePushStatus('이 휴대폰 푸시 등록 자동 복원 완료','success');
  }catch(error){
    console.error(error);
    setPushButtonRegistered(false);
    setPhonePushStatus('등록상태 확인 실패: '+error.message,'error');
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

  setTimeout(restorePhonePushRegistration,700);
});

document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){
    setTimeout(restorePhonePushRegistration,400);
  }
});
'@

$regexOptions = [System.Text.RegularExpressions.RegexOptions]::Singleline
$regex = New-Object System.Text.RegularExpressions.Regex($oldBlockPattern, $regexOptions)

if (!$regex.IsMatch($html)) {
  Write-Host "ERROR: v16 load block could not be located." -ForegroundColor Red
  Write-Host "The index.html structure is different from the expected v16 version."
  Read-Host "Press Enter"
  exit 1
}

$html = $regex.Replace($html, $newBlock, 1)
$html = $html.Replace('order-alert-v16','order-alert-v17')
$html = $html.Replace('order-alert-v15','order-alert-v17')

Set-Content -Path $indexPath -Value $html -Encoding UTF8

Write-Host ""
Write-Host "SUCCESS: v17 push registration restore installed." -ForegroundColor Green
Write-Host "Firebase configuration was preserved." -ForegroundColor Green
Write-Host ""
Write-Host "Next: Commit and Push with GitHub Desktop." -ForegroundColor Cyan
Write-Host ""

Read-Host "Press Enter"
