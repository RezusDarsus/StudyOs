import { describe, expect, it } from 'vitest';
import { computeFinancialFeasibility, monthlyCapPeriods, monthlyOpportunities, parseFinancialPlan } from './financial-plan.js';

describe('financial planning',()=>{
  it('calculates same-currency monthly feasibility',()=>{
    const result=computeFinancialFeasibility({
      target:{amount:2000,currency:'EUR'}, contribution:{amount:400,currency:'EUR',frequency:'MONTHLY'},
      existingSavings:{amount:400,currency:'EUR'}, deadline:'2027-01-31',
    },'2026-08-25');
    expect(result.requiredContributions).toBe(4);
    expect(result.feasible).toBe(true);
  });

  it('converts currencies in the correct direction',()=>{
    const result=computeFinancialFeasibility({
      target:{amount:1800,currency:'USD'}, contribution:{amount:700,currency:'GEL',frequency:'MONTHLY'},
      existingSavings:{amount:0,currency:'GEL'}, exchangeRate:{base:'USD',quote:'GEL',value:2.75,source:'ASSUMPTION'},
      deadline:'2027-01-15',
    },'2026-08-25');
    expect(result.targetInContributionCurrency).toBe(4950);
    expect(result.requiredContributions).toBe(8);
    expect(result.feasible).toBe(false);
  });

  it('reports a missing exchange rate instead of mixing units',()=>{
    const result=computeFinancialFeasibility({
      target:{amount:1800,currency:'USD'}, contribution:{amount:700,currency:'GEL',frequency:'MONTHLY'},
      deadline:'2027-01-15',
    },'2026-08-25');
    expect(result.targetInContributionCurrency).toBeNull();
    expect(result.missing).toContain('EXCHANGE_RATE');
  });

  it('includes existing savings and counts deadline opportunities',()=>{
    expect(monthlyOpportunities('2026-08-25','2027-01-15')).toBe(6);
    const result=computeFinancialFeasibility({
      target:{amount:4950,currency:'GEL'}, contribution:{amount:700,currency:'GEL',frequency:'MONTHLY'},
      existingSavings:{amount:1450,currency:'GEL'}, deadline:'2027-01-15',
    },'2026-08-25');
    expect(result.requiredContributions).toBe(5);
    expect(result.feasible).toBe(true);
  });

  it('parses the cross-currency laptop structure and labeled assumption',()=>{
    const source='I need $1,800 for a laptop by January 15, 2027. I can set aside 700 GEL monthly.';
    const plan=parseFinancialPlan(source,'Planning assumption: 2.75 GEL per USD.');
    expect(plan).toMatchObject({
      target:{amount:1800,currency:'USD'}, contribution:{amount:700,currency:'GEL',frequency:'MONTHLY'},
      exchangeRate:{base:'USD',quote:'GEL',value:2.75,source:'ASSUMPTION'}, deadline:'2027-01-15',
    });
  });

  it('removes explicitly skipped contribution months',()=>{
    const plan=parseFinancialPlan('I need €4,800 by September 30, 2027. I can save €350 per month, except nothing in December 2026 and January 2027.','')!;
    const result=computeFinancialFeasibility(plan,'2026-08-25');
    expect(result.maximumContributionOpportunities).toBe(12);
    expect(result.maximumContributable).toBe(4200);
    expect(result.shortfall).toBe(600);
  });

  it('sums variable caps and includes existing savings',()=>{
    const source='By August 31, 2027 eliminate a €3,600 balance and build a €5,000 fund. We have €900 available now and can contribute €650 per month from September through November, €300 in December and January, and €700 per month from February onward. Calculate whether the combined €8,600 objective fits.';
    const plan=parseFinancialPlan(source,'')!;
    const result=computeFinancialFeasibility(plan,'2026-08-25');
    expect(plan.target).toEqual({amount:8600,currency:'EUR'});
    expect(result.maximumContributable).toBe(7450);
    expect(result.remaining).toBe(7700);
    expect(result.shortfall).toBe(250);
    expect(result.feasible).toBe(false);
    expect(monthlyCapPeriods(plan,'2026-08-25')).toEqual([
      {amount:650,currency:'EUR',activeFrom:'2026-09-01',activeUntil:'2026-11-30'},
      {amount:300,currency:'EUR',activeFrom:'2026-12-01',activeUntil:'2027-01-31'},
      {amount:700,currency:'EUR',activeFrom:'2027-02-01',activeUntil:'2027-08-31'},
    ]);
  });

  it('uses the conservative floor for a percentage-of-income contribution',()=>{
    const source='I want a $7,500 reserve by April 30, 2027. Each month I can transfer 20% of income, which usually ranges from $2,000 to $4,500.';
    const plan=parseFinancialPlan(source,'')!;
    expect(plan.target).toEqual({amount:7500,currency:'USD'});
    expect(plan.contribution).toEqual({amount:400,currency:'USD',frequency:'MONTHLY'});
  });
});
