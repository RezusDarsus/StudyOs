import type { DayString } from '../domain/dates.js';

export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'GEL';
export interface Money { amount: number; currency: CurrencyCode }
export interface ExchangeRate { base: CurrencyCode; quote: CurrencyCode; value: number; source: 'USER' | 'ASSUMPTION' }
export interface FinancialPlan {
  target: Money;
  contribution: Money & { frequency: 'MONTHLY' };
  existingSavings?: Money;
  exchangeRate?: ExchangeRate;
  deadline?: DayString;
  skippedMonths?: string[];
  monthlyCaps?: Array<{ amount:number; currency:CurrencyCode; monthsOfYear?:number[]; startsAtMonth?:number }>;
}
export interface FinancialFeasibility {
  targetInContributionCurrency: number | null;
  remaining: number | null;
  requiredContributions: number | null;
  maximumContributionOpportunities: number | null;
  feasible: boolean | null;
  maximumContributable: number | null;
  shortfall: number | null;
  missing: Array<'EXCHANGE_RATE' | 'EXISTING_SAVINGS' | 'DEADLINE'>;
}

function convert(amount: Money, currency: CurrencyCode, rate?: ExchangeRate): number | null {
  if (amount.currency === currency) return amount.amount;
  if (!rate || rate.value <= 0) return null;
  if (rate.base === amount.currency && rate.quote === currency) return amount.amount * rate.value;
  if (rate.quote === amount.currency && rate.base === currency) return amount.amount / rate.value;
  return null;
}

/** Optimistic upper bound when the exact first transfer date is unknown. */
export function monthlyOpportunities(today: DayString, deadline: DayString): number {
  if (deadline < today) return 0;
  const [startYear, startMonth] = today.split('-').map(Number);
  const [endYear, endMonth] = deadline.split('-').map(Number);
  return Math.max(0, (endYear - startYear) * 12 + endMonth - startMonth + 1);
}

function monthsThrough(today:DayString,deadline:DayString):Array<{key:string;month:number}>{
  const [startYear,startMonth]=today.split('-').map(Number);
  const [endYear,endMonth]=deadline.split('-').map(Number);
  const result:Array<{key:string;month:number}>=[];
  for(let year=startYear,month=startMonth;year<endYear||year===endYear&&month<=endMonth;){
    result.push({key:`${year}-${String(month).padStart(2,'0')}`,month});
    month+=1;
    if(month===13){month=1;year+=1;}
  }
  return result;
}

export interface MonthlyCapPeriod {amount:number;currency:CurrencyCode;activeFrom:DayString;activeUntil:DayString}

/** Turn named cap rules into bounded executable calendar phases. */
export function monthlyCapPeriods(plan:FinancialPlan,today:DayString):MonthlyCapPeriod[]{
  if(!plan.deadline||!plan.monthlyCaps?.length)return[];
  const months=monthsThrough(today,plan.deadline);
  const rows=months.flatMap((month,index)=>{
    const rule=plan.monthlyCaps!.find((candidate)=>{
      if(candidate.monthsOfYear?.includes(month.month))return true;
      if(candidate.startsAtMonth===undefined)return false;
      const startIndex=months.findIndex((item)=>item.month===candidate.startsAtMonth);
      return startIndex>=0&&index>=startIndex;
    });
    return rule?[{key:month.key,amount:rule.amount,currency:rule.currency}]:[];
  });
  const periods:MonthlyCapPeriod[]=[];
  for(const row of rows){
    const previous=periods.at(-1);
    const [year,month]=row.key.split('-').map(Number);
    const finalDay=new Date(Date.UTC(year,month,0)).getUTCDate();
    const activeFrom=`${row.key}-01` as DayString;
    const calendarEnd=`${row.key}-${String(finalDay).padStart(2,'0')}` as DayString;
    const activeUntil=calendarEnd>plan.deadline?plan.deadline:calendarEnd;
    const priorMonth=previous?.activeUntil.slice(0,7);
    const distance=priorMonth?((year-Number(priorMonth.slice(0,4)))*12+month-Number(priorMonth.slice(5,7))):99;
    if(previous&&previous.amount===row.amount&&previous.currency===row.currency&&distance===1)previous.activeUntil=activeUntil;
    else periods.push({amount:row.amount,currency:row.currency,activeFrom,activeUntil});
  }
  return periods;
}

export function computeFinancialFeasibility(
  plan: FinancialPlan,
  today: DayString,
): FinancialFeasibility {
  const missing: FinancialFeasibility['missing'] = [];
  const target = convert(plan.target, plan.contribution.currency, plan.exchangeRate);
  if (target === null) missing.push('EXCHANGE_RATE');
  let existing = 0;
  if (plan.existingSavings) {
    const converted = convert(plan.existingSavings, plan.contribution.currency, plan.exchangeRate);
    if (converted === null) {
      if (!missing.includes('EXCHANGE_RATE')) missing.push('EXCHANGE_RATE');
    } else existing = converted;
  } else {
    missing.push('EXISTING_SAVINGS');
  }
  if (!plan.deadline) missing.push('DEADLINE');
  const remaining = target === null ? null : Math.max(0, target - existing);
  const requiredContributions = remaining === null ? null : Math.ceil(remaining / plan.contribution.amount);
  const months=plan.deadline?monthsThrough(today,plan.deadline):null;
  const eligibleMonths=months?.filter((month)=>!plan.skippedMonths?.includes(month.key))??null;
  const opportunities=eligibleMonths?.length??null;
  let maximumContributable:number|null=opportunities===null?null:opportunities*plan.contribution.amount;
  if(eligibleMonths&&plan.monthlyCaps?.length){
    maximumContributable=monthlyCapPeriods(plan,today).reduce((sum,period)=>{
      const [startYear,startMonth]=period.activeFrom.split('-').map(Number);
      const [endYear,endMonth]=period.activeUntil.split('-').map(Number);
      return sum+(((endYear-startYear)*12+endMonth-startMonth)+1)*period.amount;
    },0);
  }
  const shortfall=remaining===null||maximumContributable===null?null:Math.max(0,remaining-maximumContributable);
  const feasible=shortfall===null?null:shortfall===0;
  return {
    targetInContributionCurrency: target,
    remaining,
    requiredContributions,
    maximumContributionOpportunities: opportunities,
    feasible,
    maximumContributable,
    shortfall,
    missing,
  };
}

const CURRENCY: Record<string, CurrencyCode> = { '$':'USD', '€':'EUR', '£':'GBP', USD:'USD', EUR:'EUR', GBP:'GBP', GEL:'GEL' };
const moneyPattern = /([$€£]|USD|EUR|GBP|GEL)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*(USD|EUR|GBP|GEL)/gi;
const monthNames=['january','february','march','april','may','june','july','august','september','october','november','december'];
const monthNumber=(name:string)=>monthNames.indexOf(name.toLowerCase())+1;

function monies(text: string): Array<Money & { index: number }> {
  return [...text.matchAll(moneyPattern)].map((match)=>({
    amount:Number((match[2]??match[3]).replace(/,/g,'')),
    currency:CURRENCY[(match[1]??match[4]).toUpperCase()]??CURRENCY[match[1]??match[4]],
    index:match.index??0,
  }));
}

export function parseFinancialPlan(sourceText: string, outputText: string): FinancialPlan | null {
  const opening=sourceText.split('\n',1)[0];
  const sourceMoney=monies(opening);
  const monthlyIndex=opening.search(/\b(?:monthly|per month|each month)\b/i);
  if (monthlyIndex<0 || sourceMoney.length < 2) return null;
  const contribution=[...sourceMoney]
    .filter((money)=>money.index<monthlyIndex && monthlyIndex-money.index<100)
    .sort((a,b)=>b.index-a.index)[0];
  if(!contribution) return null;
  const percentageIncome=opening.match(/(\d+(?:\.\d+)?)%\s+of\s+income[^.]{0,100}?ranges?\s+from\s+([$€£]|USD|EUR|GBP|GEL)\s*([\d,]+(?:\.\d+)?)\s+to\s+(?:[$€£]|USD|EUR|GBP|GEL)?\s*([\d,]+(?:\.\d+)?)/i);
  const contributionAmount=percentageIncome
    ? Number(percentageIncome[3].replace(/,/g,''))*Number(percentageIncome[1])/100
    : contribution.amount;
  const contributionCurrency=percentageIncome
    ? (CURRENCY[percentageIncome[2].toUpperCase()]??CURRENCY[percentageIncome[2]])
    : contribution.currency;
  const combinedTarget=[...sourceMoney].reverse().find((money)=>/combined|objective|total/i.test(opening.slice(Math.max(0,money.index-35),money.index)));
  const targetMoney=combinedTarget??sourceMoney[0];
  const existingMatch=opening.match(/(?:have|already saved|starting with)\s*([$€£]|USD|EUR|GBP|GEL)?\s*([\d,]+(?:\.\d+)?)\s*(USD|EUR|GBP|GEL)?\s*(?:available\s+)?now/i);
  const combined=`${sourceText}\n${outputText}`;
  const rateMatch=combined.match(/(\d+(?:\.\d+)?)\s*(USD|EUR|GBP|GEL)\s+per\s+(USD|EUR|GBP|GEL)/i)
    ?? combined.match(/1\s*(USD|EUR|GBP|GEL)\s*(?:=|equals?)\s*(\d+(?:\.\d+)?)\s*(USD|EUR|GBP|GEL)/i);
  let exchangeRate:ExchangeRate|undefined;
  if(rateMatch){
    if(/^\d/.test(rateMatch[1])) exchangeRate={value:Number(rateMatch[1]),quote:rateMatch[2].toUpperCase() as CurrencyCode,base:rateMatch[3].toUpperCase() as CurrencyCode,source:/assum/i.test(outputText)?'ASSUMPTION':'USER'};
    else exchangeRate={base:rateMatch[1].toUpperCase() as CurrencyCode,value:Number(rateMatch[2]),quote:rateMatch[3].toUpperCase() as CurrencyCode,source:/assum/i.test(outputText)?'ASSUMPTION':'USER'};
  }
  const deadlineMatch=opening.match(/(?:by|before)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})/i);
  const deadline=deadlineMatch
    ? `${deadlineMatch[3]}-${String(monthNames.indexOf(deadlineMatch[1].toLowerCase())+1).padStart(2,'0')}-${String(Number(deadlineMatch[2])).padStart(2,'0')}` as DayString
    : undefined;
  const skippedMonths:string[]=[];
  const exception=opening.match(/(?:nothing|zero|skip(?:ped)?|no contribution)[^.]{0,160}/i)?.[0]??'';
  for(const match of exception.matchAll(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})/gi)){
    skippedMonths.push(`${match[2]}-${String(monthNumber(match[1])).padStart(2,'0')}`);
  }
  const monthlyCaps:NonNullable<FinancialPlan['monthlyCaps']>=[];
  const rangePattern=/([$€£]|USD|EUR|GBP|GEL)\s*([\d,]+(?:\.\d+)?)\s*(?:per month\s*)?from\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:through|to|until)\s+(January|February|March|April|May|June|July|August|September|October|November|December)/gi;
  for(const match of opening.matchAll(rangePattern)){
    const start=monthNumber(match[3]);const end=monthNumber(match[4]);const months:number[]=[];
    for(let month=start;;month=month===12?1:month+1){months.push(month);if(month===end)break;}
    monthlyCaps.push({amount:Number(match[2].replace(/,/g,'')),currency:CURRENCY[match[1].toUpperCase()]??CURRENCY[match[1]],monthsOfYear:months});
  }
  const listPattern=/([$€£]|USD|EUR|GBP|GEL)\s*([\d,]+(?:\.\d+)?)\s+(?:per month\s+)?in\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+and\s+(January|February|March|April|May|June|July|August|September|October|November|December)/gi;
  for(const match of opening.matchAll(listPattern))monthlyCaps.push({amount:Number(match[2].replace(/,/g,'')),currency:CURRENCY[match[1].toUpperCase()]??CURRENCY[match[1]],monthsOfYear:[monthNumber(match[3]),monthNumber(match[4])]});
  const onwardPattern=/([$€£]|USD|EUR|GBP|GEL)\s*([\d,]+(?:\.\d+)?)\s*(?:per month\s*)?from\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+onward/gi;
  for(const match of opening.matchAll(onwardPattern))monthlyCaps.push({amount:Number(match[2].replace(/,/g,'')),currency:CURRENCY[match[1].toUpperCase()]??CURRENCY[match[1]],startsAtMonth:monthNumber(match[3])});
  return {
    target:{amount:targetMoney.amount,currency:targetMoney.currency},
    contribution:{amount:contributionAmount,currency:contributionCurrency,frequency:'MONTHLY'},
    existingSavings:existingMatch ? {
      amount:Number(existingMatch[2].replace(/,/g,'')),
      currency:(CURRENCY[(existingMatch[1]??existingMatch[3])?.toUpperCase()]??CURRENCY[existingMatch[1]??existingMatch[3]]) as CurrencyCode,
    } : undefined,
    exchangeRate,
    deadline,
    skippedMonths:skippedMonths.length?skippedMonths:undefined,
    monthlyCaps:monthlyCaps.length?monthlyCaps:undefined,
  };
}
