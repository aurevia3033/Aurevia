'use client';

import {useEffect,useRef,useState} from 'react';
import {LoaderCircle,Maximize,Pause,Play,RotateCcw,Volume2,VolumeX} from 'lucide-react';

type Props={kind:'video'|'embed';url:string;title:string};
type PlaybackState='loading'|'ready'|'playing'|'paused'|'ended'|'error';

export default function NewsMediaPlayer({kind,url,title}:Props){
	const frameRef=useRef<HTMLDivElement>(null);
	const videoRef=useRef<HTMLVideoElement>(null);
	const autoplayAttempted=useRef(false);
	const [playbackState,setPlaybackState]=useState<PlaybackState>('loading');
	const [isMuted,setIsMuted]=useState(true);
	const [isPortrait,setIsPortrait]=useState(false);
	const [retryCount,setRetryCount]=useState(0);
	const [controlError,setControlError]=useState('');

	async function togglePlayback(){
		const video=videoRef.current;
		if(!video||playbackState==='loading'||playbackState==='error')return;
		setControlError('');
		if(!video.paused){
			video.pause();
			return;
		}
		try{
			await video.play();
		}catch{
			setPlaybackState('error');
		}
	}

	async function replay(){
		const video=videoRef.current;
		if(!video||playbackState==='loading'||playbackState==='error')return;
		setControlError('');
		try{
			video.pause();
			if(video.currentTime>0){
				await new Promise<void>((resolve,reject)=>{
					const finish=(error?:Error)=>{
						window.clearTimeout(timeout);
						video.removeEventListener('seeked',onSeeked);
						video.removeEventListener('error',onError);
						if(error)reject(error);
						else resolve();
					};
					const onSeeked=()=>finish();
					const onError=()=>finish(new Error('Video could not seek to the beginning.'));
					const timeout=window.setTimeout(()=>finish(new Error('Video seek timed out.')),3000);
					video.addEventListener('seeked',onSeeked,{once:true});
					video.addEventListener('error',onError,{once:true});
					video.currentTime=0;
				});
			}else{
				video.currentTime=0;
			}
			await video.play();
		}catch{
			setPlaybackState('error');
		}
	}

	async function toggleFullscreen(){
		const frame=frameRef.current;
		const video=videoRef.current as (HTMLVideoElement&{webkitEnterFullscreen?:()=>void})|null;
		if(!frame)return;
		setControlError('');
		if(!frame.requestFullscreen&&video?.webkitEnterFullscreen){
			try{
				video.webkitEnterFullscreen();
			}catch{
				setControlError('Fullscreen could not be opened. Try again.');
			}
			return;
		}
		try{
			await frame.requestFullscreen();
		}catch{
			if(video?.webkitEnterFullscreen){
				try{
					video.webkitEnterFullscreen();
					return;
				}catch{
					setControlError('Fullscreen could not be opened. Try again.');
					return;
				}
			}
			setControlError('Fullscreen is not available in this browser.');
		}
	}

	function retry(){
		autoplayAttempted.current=false;
		setPlaybackState('loading');
		setControlError('');
		setRetryCount(value=>value+1);
	}

	useEffect(()=>{
		if(videoRef.current)videoRef.current.muted=isMuted;
	},[isMuted,retryCount]);

	useEffect(()=>{
		const video=videoRef.current;
		if(kind!=='video'||!video||!(/\.m3u8(?:$|[?#])/i.test(url))||video.canPlayType('application/vnd.apple.mpegurl'))return;
		let active=true;
		let player:import('hls.js').default|null=null;
		void import('hls.js').then(({default:Hls})=>{
			if(!active)return;
			if(!Hls.isSupported()){
				setPlaybackState('error');
				return;
			}
			player=new Hls();
			player.attachMedia(video);
			player.on(Hls.Events.MEDIA_ATTACHED,()=>player?.loadSource(url));
			player.on(Hls.Events.ERROR,(_event,data)=>{
				if(active&&data.fatal)setPlaybackState('error');
			});
		}).catch(()=>{if(active)setPlaybackState('error')});
		return()=>{
			active=false;
			player?.destroy();
		};
	},[kind,retryCount,url]);

	if(kind==='embed'){
		return <div className="news-feed-media" role="group" aria-label={`${title} video`}>
			<div className="news-feed-media-frame">
				<iframe
					className="news-feed-embed"
					src={url}
					title={`${title} video`}
					allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
					allowFullScreen
					loading="lazy"
					referrerPolicy="strict-origin-when-cross-origin"
				/>
			</div>
		</div>;
	}

	return <div className="news-feed-media" role="group" aria-label={`${title} video`}>
		<div
			className={`news-feed-media-frame${isPortrait?' is-portrait':''}`}
			ref={frameRef}
		>
			<video
				key={retryCount}
				ref={videoRef}
				className="news-feed-video"
				src={url}
				aria-label={title}
				muted={isMuted}
				playsInline
				autoPlay
				preload="auto"
				onLoadStart={()=>setPlaybackState('loading')}
				onLoadedMetadata={event=>setIsPortrait(event.currentTarget.videoHeight>event.currentTarget.videoWidth)}
				onCanPlay={event=>{
					setPlaybackState('ready');
					if(!autoplayAttempted.current){
						autoplayAttempted.current=true;
						event.currentTarget.muted=true;
						setIsMuted(true);
						void event.currentTarget.play().catch(()=>setPlaybackState('ready'));
					}
				}}
				onPlaying={()=>setPlaybackState('playing')}
				onPause={event=>{
					if(event.currentTarget.ended)setPlaybackState('ended');
					else if(playbackState!=='error')setPlaybackState('paused');
				}}
				onEnded={()=>setPlaybackState('ended')}
				onError={()=>setPlaybackState('error')}
			/>
			{playbackState==='loading'&&<p className="news-feed-player-message" role="status">Loading video…</p>}
			{playbackState==='error'&&<div className="news-feed-player-error" role="alert">
				<p>This video could not be loaded or played.</p>
				<button type="button" onClick={retry}>Retry video</button>
			</div>}
			{playbackState!=='error'&&<button
				type="button"
				className={`news-feed-player-center${playbackState==='playing'?' is-playing':''}`}
				onClick={()=>void (playbackState==='ended'?replay():togglePlayback())}
				disabled={playbackState==='loading'}
				aria-label={playbackState==='ended'?'Replay video from beginning':playbackState==='playing'?'Pause video in player':'Play video in player'}
			>
				{playbackState==='loading'?<LoaderCircle size={23} className="animate-spin" aria-hidden="true"/>:playbackState==='playing'?<Pause size={23} aria-hidden="true"/>:playbackState==='ended'?<RotateCcw size={23} aria-hidden="true"/>:<Play size={23} fill="currentColor" aria-hidden="true"/>}
			</button>}
		</div>
		<div className="news-feed-player-controls" aria-label="Video controls">
			<button type="button" onClick={()=>void togglePlayback()} disabled={playbackState==='loading'||playbackState==='error'} aria-label={playbackState==='playing'?'Pause video':'Play video'}>
				{playbackState==='playing'?<Pause size={15}/>:<Play size={15}/>}
			</button>
			<button type="button" onClick={()=>setIsMuted(current=>!current)} disabled={playbackState==='loading'||playbackState==='error'} aria-label={isMuted?'Unmute video':'Mute video'}>
				{isMuted?<VolumeX size={15}/>:<Volume2 size={15}/>}
			</button>
			<button type="button" onClick={()=>void toggleFullscreen()} disabled={playbackState==='loading'||playbackState==='error'} aria-label="Fullscreen video">
				<Maximize size={15}/>
			</button>
			<button type="button" onClick={()=>void replay()} disabled={playbackState==='loading'||playbackState==='error'} aria-label="Replay video">
				<RotateCcw size={15}/>
			</button>
			{controlError&&<span className="news-feed-player-control-error" role="status">{controlError}</span>}
			{playbackState==='playing'&&<span className="news-feed-player-status" role="status">Playing</span>}
		</div>
	</div>;
}
