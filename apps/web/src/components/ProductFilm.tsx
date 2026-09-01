import { useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Check, CheckCircle2, Clock3, Pause, Play, RotateCcw, Users } from 'lucide-react';
import { UpMarker } from './ui';
import './ProductFilm.css';

const chapters = [
  { label: 'Set a goal', title: 'Make room for what matters.', copy: 'Start with an intention. Tell One Up what you want to do and what fits your life.' },
  { label: 'Shape a plan', title: 'A big goal. A small first step.', copy: 'Review a realistic schedule before you commit. The plan should work for you.' },
  { label: 'Take action', title: 'Today has a clear next move.', copy: 'Read a chapter. Mark it complete. See your effort become visible progress.' },
  { label: 'Grow together', title: 'Your pace. A little company.', copy: 'Share the goal with a friend. Keep your own progress, and give each other a reason to return.' },
];

/** Frontend-only editorial demonstration. No account data or API calls. */
export function ProductStory({ chapter }: { chapter: number }) {
  const item = chapters[chapter];
  return <div className="product-story-canvas">
    <div className="product-story-top"><span><UpMarker size={34} /><b>One Up</b></span><span>HOW A GOAL BECOMES PROGRESS</span><small>Product example</small></div>
    <div className="product-story-layout">
      <div className="product-story-narrative"><span className="product-story-number">0{chapter + 1} / 04</span><h2>{item.title}</h2><p>{item.copy}</p><div className="product-story-chapter-track" aria-hidden="true">{chapters.map((s,i)=><i className={i<=chapter?'is-current':''} key={s.label}/>)}</div></div>
      <div className="product-story-demo" key={chapter}>
        {chapter === 0 && <>
          <div className="story-kicker"><BookOpen size={18}/> A goal worth coming back to</div>
          <h3>Read 12 books this year.</h3><p className="story-goal-input">“I want to read more, but my evenings get busy.”</p>
          <div className="story-context"><span><Clock3 size={16}/> 15 minutes</span><span>3 days a week</span><span>At my own pace</span></div>
          <div className="story-action">Let’s make a plan <ArrowRight size={18}/></div>
          <small className="story-footnote">Start with your life, not a perfect routine.</small>
        </>}
        {chapter === 1 && <>
          <div className="story-kicker"><BookOpen size={18}/> Your first week · draft plan</div><h3>Build a reading rhythm.</h3>
          <div className="story-schedule">{['Monday','Wednesday','Friday'].map(d=><div key={d}><span className="story-empty-check"/><span><strong>Read for 15 minutes</strong><small>{d} · a little space for yourself</small></span><span className="story-duration">15 min</span></div>)}</div>
          <p className="story-reason"><strong>Built around your time.</strong> Three short sessions. Room between them. Review and change any detail.</p>
          <div className="story-action">This plan works for me <Check size={18}/></div>
        </>}
        {chapter === 2 && <>
          <div className="story-kicker"><CheckCircle2 size={18}/> Today · one useful action</div><h3>A chapter closer.</h3>
          <div className="story-completed-task"><span className="story-done-check"><Check size={23}/></span><span><strong>Read for 15 minutes</strong><small>Completed · your reading goal</small></span></div>
          <div className="story-progress-heading"><strong>1 of 3 sessions</strong><span>This week</span></div><div className="story-progress-bar"><i/></div>
          <div className="story-next"><span>NEXT UP</span><strong>Another 15 minutes on Wednesday.</strong><p>Nothing extra to squeeze into today.</p></div>
        </>}
        {chapter === 3 && <>
          <div className="story-kicker"><Users size={18}/> Reading together · shared goal</div><h3>Different days. Shared direction.</h3>
          <div className="story-friend"><span className="story-avatar">Y</span><div><strong>You</strong><small>1 of 3 sessions this week</small></div><CheckCircle2 size={20}/></div>
          <div className="story-friend"><span className="story-avatar story-avatar-friend">M</span><div><strong>Maya</strong><small>2 of 3 sessions this week</small></div><CheckCircle2 size={20}/></div>
          <div className="story-shared-progress"><span>Every session counts.</span><strong>3 sessions, together.</strong><div><i/><i/><i/><i/><i/><i/></div></div>
          <small className="story-footnote">Example people and activity. Your goals stay yours.</small>
        </>}
      </div>
    </div>
  </div>;
}

export default function ProductFilm() {
  const [mode, setMode] = useState<'film'|'story'>('film');
  const [chapter, setChapter] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const manuallyPaused = useRef(false);
  const [playing, setPlaying] = useState(false);
  useEffect(()=>{
    const video=videoRef.current;
    if (!video || mode !== 'film') return;
    const preference=window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible=false;
    const sync=()=>{
      if (visible && !document.hidden && !preference.matches && !manuallyPaused.current) void video.play().catch(()=>setPlaying(false));
      else video.pause();
    };
    const observer=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;sync();},{threshold:.5});
    observer.observe(video); preference.addEventListener('change',sync); document.addEventListener('visibilitychange',sync);
    return ()=>{observer.disconnect();preference.removeEventListener('change',sync);document.removeEventListener('visibilitychange',sync);video.pause();};
  },[mode]);
  function playFilm(){
    const video=videoRef.current;if(!video)return;
    if(playing){manuallyPaused.current=true;video.pause();}
    else {manuallyPaused.current=false;void video.play().catch(()=>setMode('story'));}
  }
  return <section className="product-film" aria-label="See how One Up works" id="product-film">
    <div className="product-film-mobile"><ProductStory chapter={chapter}/></div>
    <div className="product-film-desktop">{mode==='film' ? <video ref={videoRef} muted playsInline preload="none" poster="/assets/oneup-product-poster.png" aria-label="One Up product film: goal, plan, daily action, shared progress" onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>{manuallyPaused.current=true;setPlaying(false);}} onError={()=>setMode('story')}><source src="/assets/oneup-product-film.mp4" type="video/mp4"/></video> : <ProductStory chapter={chapter}/>}</div>
    <div className="product-film-controls">
      <div className="product-film-chapters" role="group" aria-label="Explore the product story">{chapters.map((item,i)=><button key={item.label} aria-pressed={mode==='story'&&chapter===i} onClick={()=>{setMode('story');setChapter(i);}}><span>0{i+1}</span>{item.label}</button>)}</div>
      <button className="product-film-play" onClick={()=>{if(mode==='story'){manuallyPaused.current=false;setMode('film');}else playFilm();}}>{mode==='story'?<RotateCcw size={16}/>:playing?<Pause size={16}/>:<Play size={16}/>} <span>{mode==='story'?'Back to film':playing?'Pause film':'Play film'}</span></button>
    </div>
    <p className="product-film-caption">A product walkthrough with sample goals and people. No account needed.</p>
  </section>;
}
