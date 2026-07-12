
$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexPath = Join-Path $project "index.html"
$swPath = Join-Path $project "sw.js"

if (!(Test-Path $indexPath)) {
  Write-Host "ERROR: index.html not found." -ForegroundColor Red
  Write-Host "Copy this patch into the alldaypick-order-alert folder first."
  Read-Host "Press Enter"
  exit 1
}

$html = Get-Content -Raw -Encoding UTF8 $indexPath

if ($html -match 'V25_REMOVE_VOICE_VOLUME') {
  Write-Host "v25 voice volume cleanup is already installed." -ForegroundColor Yellow
  Read-Host "Press Enter"
  exit 0
}

$style = @'
  <style id="V25_REMOVE_VOICE_VOLUME">
    /* Remove voice volume controls without affecting push notifications. */
    [id*="voiceVolume" i],
    [id*="speechVolume" i],
    [id*="soundVolume" i],
    [class*="voice-volume" i],
    [class*="speech-volume" i],
    [class*="sound-volume" i],
    .v25-hidden-volume-control{
      display:none !important;
    }
  </style>
'@

$html = $html.Replace('</head>', $style + "`r`n</head>")

$script = @'
const V25_REMOVE_VOICE_VOLUME=true;

function v25RemoveVoiceVolumeControls(){
  const directSelectors=[
    '[id*="voiceVolume" i]',
    '[id*="speechVolume" i]',
    '[id*="soundVolume" i]',
    '[class*="voice-volume" i]',
    '[class*="speech-volume" i]',
    '[class*="sound-volume" i]'
  ];

  document.querySelectorAll(directSelectors.join(',')).forEach(el=>{
    const wrapper=
      el.closest('label')||
      el.closest('.field')||
      el.closest('.setting-row')||
      el.closest('.form-row')||
      el.parentElement;

    (wrapper||el).classList.add('v25-hidden-volume-control');
  });

  document.querySelectorAll('input[type="range"]').forEach(input=>{
    const wrapper=
      input.closest('label')||
      input.closest('.field')||
      input.closest('.setting-row')||
      input.closest('.form-row')||
      input.parentElement;

    const text=(wrapper?.textContent||'')
      .replace(/\s+/g,' ')
      .trim();

    if(
      text.includes('음성')&&
      (
        text.includes('볼륨')||
        text.includes('소리 크기')||
        text.includes('소리크기')||
        text.includes('크기 조절')
      )
    ){
      wrapper?.classList.add('v25-hidden-volume-control');
      input.disabled=true;
      input.value='1';
    }
  });

  [
    'voiceVolume',
    'speechVolume',
    'soundVolume',
    'voice_volume',
    'speech_volume',
    'sound_volume'
  ].forEach(key=>{
    try{
      localStorage.removeItem(key);
    }catch{}
  });
}

window.addEventListener('load',()=>{
  setTimeout(v25RemoveVoiceVolumeControls,500);
});

const v25VolumeObserver=new MutationObserver(()=>{
  v25RemoveVoiceVolumeControls();
});

window.addEventListener('load',()=>{
  v25VolumeObserver.observe(document.body,{
    childList:true,
    subtree:true
  });
});
'@

$html = $html.Replace('</script>', $script + "`r`n</script>")
$html = $html.Replace('order-alert-v24','order-alert-v25')
$html = $html.Replace('order-alert-v23','order-alert-v25')
$html = $html.Replace('order-alert-v22','order-alert-v25')

Set-Content -Path $indexPath -Value $html -Encoding UTF8

if (Test-Path $swPath) {
  $sw = Get-Content -Raw -Encoding UTF8 $swPath
  $sw = [regex]::Replace(
    $sw,
    "order-alert-v\d+",
    "order-alert-v25"
  )
  Set-Content -Path $swPath -Value $sw -Encoding UTF8
}

Write-Host ""
Write-Host "SUCCESS: v25 voice volume control removed." -ForegroundColor Green
Write-Host "Push notifications and order sync were preserved." -ForegroundColor Green
Write-Host ""
Write-Host "Next: Commit and Push with GitHub Desktop." -ForegroundColor Cyan
Write-Host ""

Read-Host "Press Enter"
