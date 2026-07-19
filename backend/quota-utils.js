export function quotaExceeded(error){
  const code=String(error?.code||'').toUpperCase();
  const message=String(
    error instanceof Error
      ?error.message
      :error
  ).toUpperCase();

  return (
    code.includes('RESOURCE_EXHAUSTED') ||
    message.includes('RESOURCE_EXHAUSTED') ||
    message.includes('QUOTA EXCEEDED')
  );
}

function zoneParts(date,timeZone){
  const parts=new Intl.DateTimeFormat('en-CA',{
    timeZone,
    year:'numeric',
    month:'2-digit',
    day:'2-digit',
    hour:'2-digit',
    minute:'2-digit',
    second:'2-digit',
    hour12:false
  }).formatToParts(date);

  return Object.fromEntries(
    parts.map(part=>[part.type,part.value])
  );
}

function localDateToUtcMs({
  year,month,day,hour=0,minute=0,second=0
},timeZone){
  const target=Date.UTC(
    year,month-1,day,hour,minute,second
  );
  let guess=target;

  for(let index=0;index<4;index+=1){
    const parts=zoneParts(
      new Date(guess),
      timeZone
    );
    const represented=Date.UTC(
      Number(parts.year),
      Number(parts.month)-1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    guess+=target-represented;
  }

  return guess;
}

export function nextFirestoreFreeResetMs(nowMs=Date.now()){
  const parts=zoneParts(
    new Date(nowMs),
    'America/Los_Angeles'
  );
  const targetDate=new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month)-1,
    Number(parts.day)+1
  ));

  return localDateToUtcMs({
    year:targetDate.getUTCFullYear(),
    month:targetDate.getUTCMonth()+1,
    day:targetDate.getUTCDate(),
    hour:0,
    minute:5,
    second:0
  },'America/Los_Angeles');
}
