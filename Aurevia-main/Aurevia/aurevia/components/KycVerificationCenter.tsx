'use client';

import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Country} from 'country-state-city';
import Image from 'next/image';
import Link from 'next/link';
import {Camera,CheckCircle2,ChevronLeft,ChevronRight,LoaderCircle,RefreshCw,ScanLine,ShieldCheck,SwitchCamera,Upload,Zap} from 'lucide-react';
import {parseKycIdentityInformation} from '@/lib/kyc-identity';
import {getKycImageValidationError} from '@/lib/kyc-client-validation';
import {getKycVerificationNotice} from '@/lib/kyc-status-notice';
import StatusNotice from '@/components/StatusNotice';

type DocumentType='PASSPORT'|'NATIONAL_ID'|'DRIVING_LICENCE'|'RESIDENCE_PERMIT'|'OTHER';
type DocumentRequirement={type:DocumentType;label:string;sides:string[];expiryRequired:boolean};
type KycDocument={id:string;kind:string;documentSide:string|null;filename:string;mimeType:string;size:number;status:string;uploadedAt:string;reviewedAt:string|null;reviewNote:string|null};
type KycCheck={check:string;outcome:string;reason:string};
type KycVerification={id:string;status:string;documentCountry:string;documentType:string;submittedAt:string|null;reviewedAt:string|null;decisionReason:string|null;identityInformation:{legalName:string;dateOfBirth:string;documentExpiryDate:string|null}|null;assessment:{riskLevel?:string;checks?:KycCheck[]}|null;documents:KycDocument[];events:{fromStatus:string|null;toStatus:string;action:string;reason:string|null;createdAt:string}[]};
type CaptureTarget='FRONT'|'BACK'|'SELFIE';

const statusRefreshIntervalMs=5*60_000;
const countries=Country.getAllCountries().sort((left,right)=>left.name.localeCompare(right.name));
const statusCopy:Record<string,string>={
	DRAFT:'Draft',
	SUBMITTED:'Submitted',
	PROCESSING:'Processing',
	PENDING_REVIEW:'Awaiting administrator review',
	NEEDS_REVIEW:'Additional administrator review',
	RESUBMISSION_REQUIRED:'Correction requested',
	APPROVED:'Approved',
	REJECTED:'Decision recorded',
	CANCELLED:'Superseded',
	EXPIRED:'Expired',
};
function stopTracks(stream:MediaStream|null){
	stream?.getTracks().forEach(track=>track.stop());
}

function useFilePreview(file:File|null){
	const [url,setUrl]=useState('');
	useEffect(()=>{
		if(!file){setUrl('');return}
		const previewUrl=URL.createObjectURL(file);
		setUrl(previewUrl);
		return()=>URL.revokeObjectURL(previewUrl);
	},[file]);
	return url;
}

export default function KycVerificationCenter({currentTier,onUpdated}:{currentTier:number;onUpdated:()=>void}){
	const videoRef=useRef<HTMLVideoElement>(null);
	const formRef=useRef<HTMLFormElement>(null);
	const streamRef=useRef<MediaStream|null>(null);
	const cameraRequest=useRef(0);
	const draftInProgress=useRef(false);
	const draftLoaded=useRef(false);
	const draftTimer=useRef<number|null>(null);
	const draftSaveRequest=useRef<Promise<void>|null>(null);
	const submissionInFlight=useRef(false);
	const [requirements,setRequirements]=useState<DocumentRequirement[]>([]);
	const [verifications,setVerifications]=useState<KycVerification[]>([]);
	const [country,setCountry]=useState('');
	const [documentType,setDocumentType]=useState<DocumentType>('PASSPORT');
	const [legalName,setLegalName]=useState('');
	const [dateOfBirth,setDateOfBirth]=useState('');
	const [documentExpiryDate,setDocumentExpiryDate]=useState('');
	const [front,setFront]=useState<File|null>(null);
	const [back,setBack]=useState<File|null>(null);
	const [selfie,setSelfie]=useState<File|null>(null);
	const [consent,setConsent]=useState(false);
	const [captureTarget,setCaptureTarget]=useState<CaptureTarget|null>(null);
	const [cameraStarting,setCameraStarting]=useState(false);
	const [cameraReady,setCameraReady]=useState(false);
	const [cameraFacing,setCameraFacing]=useState<'user'|'environment'>('user');
	const [cameraStreamVersion,setCameraStreamVersion]=useState(0);
	const [torchSupported,setTorchSupported]=useState(false);
	const [torchEnabled,setTorchEnabled]=useState(false);
	const [loading,setLoading]=useState(true);
	const [submitting,setSubmitting]=useState(false);
	const [step,setStep]=useState(0);
	const previousStep=useRef(step);
	const [uploadProgress,setUploadProgress]=useState<number|null>(null);
	const [draftStatus,setDraftStatus]=useState<'idle'|'saving'|'saved'|'error'>('idle');
	const [error,setError]=useState('');
	const [message,setMessage]=useState('');
	const frontPreview=useFilePreview(front);
	const backPreview=useFilePreview(back);
	const selfiePreview=useFilePreview(selfie);

	const selectedRequirement=useMemo(()=>requirements.find(item=>item.type===documentType),[documentType,requirements]);
	const latest=verifications[0]||null;
	const statusNotice=latest?getKycVerificationNotice(latest.status):null;
	const canSubmit=!submitting&&Boolean(country&&legalName.trim()&&dateOfBirth&&front&&selfie&&consent)
		&&(!selectedRequirement?.expiryRequired||Boolean(documentExpiryDate))
		&&(!selectedRequirement?.sides.includes('BACK')||Boolean(back))
		&&(!latest||['REJECTED','RESUBMISSION_REQUIRED','CANCELLED'].includes(latest.status));

	const saveDraft=useCallback(async()=>{
		const request=fetch('/api/kyc/verification/draft',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({
			documentCountry:country||null,
			documentType:documentType||null,
			legalName,
			dateOfBirth,
			documentExpiryDate,
		})}).then(async response=>{
			if(!response.ok)throw new Error('DRAFT_SAVE_UNAVAILABLE');
			setDraftStatus('saved');
		}).catch(()=>{
			setDraftStatus('error');
		});
		draftSaveRequest.current=request;
		await request;
		if(draftSaveRequest.current===request)draftSaveRequest.current=null;
	},[country,dateOfBirth,documentExpiryDate,documentType,legalName]);

	const load=useCallback(async(background=false)=>{
		if(!background)setLoading(true);
		try{
			const response=await fetch('/api/kyc/verification',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load your verification centre.');
			if(background&&draftInProgress.current)return;
			setRequirements(result.registry||[]);
			setVerifications(result.verifications||[]);
			if(!background){
				try{
					const draftResponse=await fetch('/api/kyc/verification/draft',{cache:'no-store'});
					const draftResult=await draftResponse.json();
					if(!draftResponse.ok)throw new Error('DRAFT_LOAD_UNAVAILABLE');
					const draft=draftResult.draft;
					if(draft){
						setCountry(draft.documentCountry||'');
						setDocumentType(draft.documentType||'PASSPORT');
						setLegalName(draft.identityInformation?.legalName||'');
						setDateOfBirth(draft.identityInformation?.dateOfBirth||'');
						setDocumentExpiryDate(draft.identityInformation?.documentExpiryDate||'');
						draftInProgress.current=Boolean(
							draft.documentCountry||draft.documentType||draft.identityInformation?.legalName
							||draft.identityInformation?.dateOfBirth||draft.identityInformation?.documentExpiryDate,
						);
						setDraftStatus('saved');
					}
					draftLoaded.current=true;
				}catch{
					draftLoaded.current=true;
					setDraftStatus('error');
				}
			}
			setError('');
		}catch(exception){
			if(!background||!draftInProgress.current)setError(exception instanceof Error?exception.message:'Unable to load your verification centre.');
		}finally{
			if(!background)setLoading(false);
		}
	},[]);

	const invalidateCameraRequest=useCallback(()=>{cameraRequest.current++},[]);

	useEffect(()=>{
		if(!draftLoaded.current||!draftInProgress.current||submitting)return;
		if(draftTimer.current!==null)window.clearTimeout(draftTimer.current);
		setDraftStatus('saving');
		draftTimer.current=window.setTimeout(()=>{void saveDraft()},700);
		return()=>{
			if(draftTimer.current!==null)window.clearTimeout(draftTimer.current);
		};
	},[country,dateOfBirth,documentExpiryDate,documentType,legalName,saveDraft,submitting]);

	useEffect(()=>{
		void load();
		const timer=setInterval(()=>{
			if(draftInProgress.current)return;
			void load(true);
			onUpdated();
		},statusRefreshIntervalMs);
		return()=>{clearInterval(timer);invalidateCameraRequest();stopTracks(streamRef.current);streamRef.current=null};
	},[invalidateCameraRequest,load,onUpdated]);

	useEffect(()=>()=>{if(draftTimer.current!==null)window.clearTimeout(draftTimer.current)},[]);

	useEffect(()=>{
		if(previousStep.current===step)return;
		previousStep.current=step;
		formRef.current?.querySelector<HTMLLegendElement>('fieldset:not([hidden]) legend')?.focus();
	},[step]);

	useEffect(()=>{
		if(!captureTarget)return;
		const video=videoRef.current;
		const stream=streamRef.current;
		if(!video||!stream)return;
		let active=true;
		video.srcObject=stream;
		const track=stream.getVideoTracks()[0];
		const capabilities=track&&typeof track.getCapabilities==='function'
			?track.getCapabilities() as MediaTrackCapabilities & {torch?:boolean}
			:undefined;
		setTorchSupported(Boolean(capabilities?.torch));
		void video.play().then(()=>{if(active)setCameraReady(true)}).catch(()=>{
			if(!active)return;
			setCameraReady(false);
			setError('The camera preview could not start. Close other camera apps, then try again.');
		});
		return()=>{active=false;video.srcObject=null};
	},[captureTarget,cameraStreamVersion]);

	function closeCamera(){
		cameraRequest.current++;
		stopTracks(streamRef.current);
		streamRef.current=null;
		setCaptureTarget(null);
		setCameraStarting(false);
		setCameraReady(false);
		setTorchSupported(false);
		setTorchEnabled(false);
	}

	async function startCamera(target:CaptureTarget,facing: 'user'|'environment'=target==='SELFIE'?'user':'environment'){
		const requestId=++cameraRequest.current;
		draftInProgress.current=true;
		setError('');
		setCameraStarting(true);
		setCameraReady(false);
		try{
			if(!navigator.mediaDevices?.getUserMedia)throw new Error('Your browser does not support camera access. Choose an image file instead.');
			stopTracks(streamRef.current);
			streamRef.current=null;
			// Progressive constraints: high detail first, then mid, then basic facingMode
			const constraintSets:MediaStreamConstraints[]=[
				{audio:false,video:{facingMode:{exact:facing},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}}},
				{audio:false,video:{facingMode:{ideal:facing},width:{ideal:1280},height:{ideal:720}}},
				{audio:false,video:{facingMode:facing}},
				{audio:false,video:true},
			];
			let stream:MediaStream|null=null;
			let lastError:unknown=null;
			for(const constraints of constraintSets){
				try{
					stream=await navigator.mediaDevices.getUserMedia(constraints);
					break;
				}catch(error){lastError=error}
			}
			if(!stream)throw lastError instanceof Error?lastError:new Error('Camera access is unavailable.');
			if(cameraRequest.current!==requestId){stopTracks(stream);return}
			streamRef.current=stream;
			setCameraFacing(facing);
			setCaptureTarget(target);
			setCameraStreamVersion(value=>value+1);
		}catch(exception){
			if(cameraRequest.current!==requestId)return;
			setCaptureTarget(null);
			const name=exception instanceof DOMException?exception.name:'';
			setError(name==='NotAllowedError'||name==='SecurityError'
				?'Camera permission was denied. Allow camera access for Aurevia in your browser or device settings, then retry. You can also choose an image file.'
				:name==='NotFoundError'||name==='DevicesNotFoundError'
					?'No camera was found. Connect or enable a camera, or choose an image file.'
					:name==='NotReadableError'||name==='AbortError'
						?'The camera is busy or unavailable. Close other camera apps and retry, or choose an image file.'
						:'Camera access is unavailable. Check your browser permissions and try again, or choose an image file.');
		}finally{
			if(cameraRequest.current===requestId)setCameraStarting(false);
		}
	}

	function captureImage(){
		const video=videoRef.current;
		if(!captureTarget||!cameraReady||!video||video.videoWidth<250||video.videoHeight<250){setError('Wait for the live camera preview, then try the capture again.');return}
		const sourceW=video.videoWidth;
		const sourceH=video.videoHeight;
		// Cap long edge for efficient upload while keeping document/selfie detail
		const maxEdge=captureTarget==='SELFIE'?1440:1920;
		const scale=Math.min(1,maxEdge/Math.max(sourceW,sourceH));
		const canvas=document.createElement('canvas');
		canvas.width=Math.round(sourceW*scale);
		canvas.height=Math.round(sourceH*scale);
		const context=canvas.getContext('2d');
		if(!context){setError('Camera capture is unavailable. Choose an image file or try another browser.');return}
		context.imageSmoothingEnabled=true;
		context.imageSmoothingQuality='high';
		// Mirror selfie to match preview
		if(captureTarget==='SELFIE'&&cameraFacing==='user'){
			context.translate(canvas.width,0);
			context.scale(-1,1);
		}
		context.drawImage(video,0,0,canvas.width,canvas.height);
		const quality=captureTarget==='SELFIE'?0.9:0.93;
		canvas.toBlob(blob=>{
			if(!blob){setError('The image could not be captured. Check the camera and try again.');return}
			if(blob.size<12_000){setError('The capture is too dark or blurry. Improve lighting and hold steady, then capture again.');return}
			const fileName=captureTarget==='SELFIE'?'selfie.jpg':`identity-${captureTarget.toLowerCase()}.jpg`;
			const file=new File([blob],fileName,{type:'image/jpeg',lastModified:Date.now()});
			if(captureTarget==='FRONT')selectEvidenceFile(file,setFront);
			else if(captureTarget==='BACK')selectEvidenceFile(file,setBack);
			else selectEvidenceFile(file,setSelfie);
			closeCamera();
		},'image/jpeg',quality);
	}

	function selectEvidenceFile(file:File|null,setFile:(file:File|null)=>void){
		if(!file)return;
		const validationError=getKycImageValidationError(file);
		if(validationError){setError(validationError);return}
		setFile(file);
		setError('');
	}

	function changeDocumentType(value:DocumentType){
		if(value===documentType)return;
		setDocumentType(value);
		setFront(null);
		setBack(null);
		setSelfie(null);
		setDocumentExpiryDate('');
		setConsent(false);
		setError('');
		draftInProgress.current=true;
	}

	async function toggleTorch(){
		const track=streamRef.current?.getVideoTracks()[0];
		if(!track||!torchSupported)return;
		const next=!torchEnabled;
		try{
			await track.applyConstraints({advanced:[{torch:next} as MediaTrackConstraintSet & {torch:boolean}]});
			setTorchEnabled(next);
		}catch{
			setError('This camera could not change its light setting. Continue without the torch or try another camera.');
		}
	}

	function renderCameraViewport(target:CaptureTarget){
		if(captureTarget!==target)return null;
		const isSelfie=target==='SELFIE';
		return <div className="kyc-camera-shell" data-capture-target={target}>
			<div className="kyc-camera-topline">
				<span className={`kyc-camera-live ${cameraReady?'is-ready':''}`}><i/>{cameraStarting?'Starting camera':cameraReady?'Camera ready':'Connecting camera'}</span>
				<span>{isSelfie?'SELFIE CAPTURE':'DOCUMENT CAPTURE'}</span>
			</div>
			<div className={`kyc-camera-viewport ${isSelfie?'is-selfie':'is-document'}`}>
				<video ref={videoRef} className={isSelfie&&cameraFacing==='user'?'is-mirrored':''} autoPlay playsInline muted aria-label={isSelfie?'Live selfie camera preview':'Live identity document camera preview'}/>
				<div className={`kyc-camera-guide ${isSelfie?'kyc-face-guide':'kyc-document-guide'}`} aria-hidden="true">
					<span className="kyc-guide-corner top-left"/><span className="kyc-guide-corner top-right"/>
					<span className="kyc-guide-corner bottom-left"/><span className="kyc-guide-corner bottom-right"/>
					{isSelfie&&<span className="kyc-face-oval"/>}
					<span className="kyc-scan-line"/>
				</div>
				{!cameraReady&&<div className="kyc-camera-starting" role="status">{cameraStarting?<><LoaderCircle size={18} className="animate-spin"/> Requesting camera access…</>:<>Preparing live preview…</>}</div>}
			</div>
			<div className="kyc-camera-controls">
				<button className="kyc-camera-control" type="button" onClick={()=>void startCamera(target,cameraFacing==='user'?'environment':'user')} disabled={cameraStarting} aria-label="Switch camera"><SwitchCamera size={17}/><span>Switch camera</span></button>
				{torchSupported&&<button className={`kyc-camera-control ${torchEnabled?'is-active':''}`} type="button" onClick={()=>void toggleTorch()} aria-pressed={torchEnabled}><Zap size={17}/><span>{torchEnabled?'Light on':'Light'}</span></button>}
				<button className="kyc-camera-capture" type="button" onClick={captureImage} disabled={!cameraReady}><Camera size={18}/><span>Capture {isSelfie?'selfie':'document'}</span></button>
				<button className="kyc-camera-control" type="button" onClick={closeCamera}>Cancel</button>
			</div>
		</div>;
	}

	function validateCurrentStep(){
		if(step===0){
			if(!/^[A-Z]{2}$/.test(country)){setError('Select the country that issued your document.');return false}
			if(!requirements.some(item=>item.type===documentType)){setError('Select a supported document type.');return false}
			if(legalName.trim().length<2){setError('Enter your legal name as it appears on the document.');return false}
			if(!dateOfBirth){setError('Enter your date of birth.');return false}
			try{
				const requirement=requirements.find(item=>item.type===documentType);
				if(!requirement)throw new Error('KYC_DOCUMENT_TYPE_INVALID');
				parseKycIdentityInformation({legalName,dateOfBirth,documentExpiryDate,expiryRequired:requirement.expiryRequired});
			}catch(exception){
				const message=exception instanceof Error?exception.message:'';
				setError(message==='KYC_DATE_OF_BIRTH_INVALID'?'Enter a valid date of birth in the past.'
					:message==='KYC_DOCUMENT_EXPIRY_REQUIRED'?'Enter the document expiry date.'
					:message==='KYC_DOCUMENT_EXPIRED'?'The document expiry date must be in the future.'
					:'Enter your legal name as it appears on the document.');
				return false;
			}
		}
		if(step===1){
			if(!front){setError('Add the front image of your identity document.');return false}
			if(selectedRequirement?.sides.includes('BACK')&&!back){setError('Add the back image of your identity document.');return false}
			if(!selfie){setError('Capture a selfie before continuing.');return false}
		}
		setError('');
		return true;
	}

	async function submit(event:React.FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(submissionInFlight.current||!canSubmit||step!==2)return;
		submissionInFlight.current=true;
		if(draftTimer.current!==null){window.clearTimeout(draftTimer.current);draftTimer.current=null}
		draftInProgress.current=true;
		setSubmitting(true);setError('');setMessage('');
		try{
			await draftSaveRequest.current;
			const form=new FormData();
			form.append('documentCountry',country);
			form.append('documentType',documentType);
			form.append('legalName',legalName);
			form.append('dateOfBirth',dateOfBirth);
			if(documentExpiryDate)form.append('documentExpiryDate',documentExpiryDate);
			form.append('documentFront',front!);
			if(selectedRequirement?.sides.includes('BACK')&&back)form.append('documentBack',back);
			form.append('selfie',selfie!);
			form.append('consent','true');
			await new Promise<void>((resolve,reject)=>{
				const request=new XMLHttpRequest();
				request.open('POST','/api/kyc/verification');
				request.timeout=180_000;
				request.upload.onprogress=event=>setUploadProgress(event.lengthComputable?Math.round(event.loaded/event.total*100):null);
				request.onerror=()=>reject(new Error('The evidence upload was interrupted. Check your connection and try again.'));
				request.ontimeout=()=>reject(new Error('The upload timed out. Your draft is saved; retry when your connection is stable.'));
				request.onabort=()=>reject(new Error('The upload was interrupted. Your draft is saved; try again.'));
				request.onload=()=>{
					let body:Record<string,unknown>;
					try{body=JSON.parse(request.responseText) as Record<string,unknown>}
					catch{reject(new Error('The verification response could not be read.'));return}
					if(request.status<200||request.status>=300){reject(new Error(typeof body.error==='string'?body.error:'Unable to submit your identity verification.'));return}
					resolve();
				};
				request.send(form);
			});
			setFront(null);setBack(null);setSelfie(null);setConsent(false);
			draftInProgress.current=false;
			setDraftStatus('idle');
			setUploadProgress(null);
			setMessage('Your submission was received and is awaiting administrator review.');
			await load();onUpdated();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to submit your identity verification.');setUploadProgress(null)}
		finally{submissionInFlight.current=false;setSubmitting(false)}
	}

	return <section className="account-panel card mt-4 p-5" aria-labelledby="aurevia-verify-title">
		<div className="account-panel-title"><div><span className="account-kicker">AUREVIA VERIFY</span><h2 id="aurevia-verify-title" className="mt-1 text-xl font-semibold">First-party verification centre</h2></div><ShieldCheck size={20} className="gold" aria-hidden="true"/></div>
		<div className="mt-4 grid gap-3 sm:grid-cols-3">
			<div className="rounded-lg border border-white/10 bg-black/20 p-3"><span className="text-xs muted">Current account tier</span><p className="mt-1 font-semibold">Tier {currentTier}</p></div>
			<div className="rounded-lg border border-white/10 bg-black/20 p-3"><span className="text-xs muted">Verification status</span><p className="mt-1 font-semibold">{latest?statusCopy[latest.status]||latest.status.replaceAll('_',' '):'Not started'}</p></div>
			<div className="rounded-lg border border-white/10 bg-black/20 p-3"><span className="text-xs muted">Review type</span><p className="mt-1 font-semibold">Manual review</p></div>
		</div>
		{error&&<p className="mt-3 text-sm text-loss" role="alert">{error}</p>}
		{message&&!statusNotice&&<p className="mt-3 text-sm text-profit" role="status">{message}</p>}
		{loading?<p className="mt-4 muted"><LoaderCircle className="mr-2 inline animate-spin" size={16}/>Loading verification history…</p>:<>
			{statusNotice&&<StatusNotice {...statusNotice} description={undefined}/>}
			{latest&&<article className="mt-4 rounded-lg border border-white/10 p-4">
				<div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">{latest.documentType.replaceAll('_',' ')} · {latest.documentCountry}</h3><p className="mt-1 text-sm muted">{statusCopy[latest.status]||latest.status.replaceAll('_',' ')} · {latest.submittedAt?`Submitted ${new Date(latest.submittedAt).toLocaleString()}`:'Not submitted'}{latest.reviewedAt?` · Reviewed ${new Date(latest.reviewedAt).toLocaleString()}`:''}</p></div><span className="status-pill">{latest.assessment?.riskLevel?.replaceAll('_',' ')||'Manual review'}</span></div>
				{latest.decisionReason&&<p className="mt-3 text-sm leading-6">{latest.decisionReason}</p>}
				{latest.identityInformation&&<dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3"><div><dt className="text-xs muted">Submitted legal name</dt><dd>{latest.identityInformation.legalName}</dd></div><div><dt className="text-xs muted">Date of birth</dt><dd>{latest.identityInformation.dateOfBirth}</dd></div>{latest.identityInformation.documentExpiryDate&&<div><dt className="text-xs muted">Document expiry date</dt><dd>{latest.identityInformation.documentExpiryDate}</dd></div>}</dl>}
				{latest.documents.length>0&&<ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">{latest.documents.map(document=><li className="rounded border border-white/10 p-2" key={document.id}>{document.documentSide?.replaceAll('_',' ')||document.kind.replaceAll('_',' ')} · {document.status.replaceAll('_',' ')}<span className="block truncate text-xs muted">{document.filename}</span>{document.reviewNote&&<span className="mt-1 block text-xs">{document.reviewNote}</span>}</li>)}</ul>}
				<details className="mt-3"><summary className="cursor-pointer text-sm gold">Assessment checks</summary><ul className="mt-2 space-y-2 text-xs">{latest.assessment?.checks?.map(check=><li key={check.check}><b>{check.check.replaceAll('_',' ')} · {check.outcome.replaceAll('_',' ')}</b></li>)}</ul></details>
			</article>}
			{latest&&['PENDING_REVIEW','PROCESSING','SUBMITTED','NEEDS_REVIEW'].includes(latest.status)?null:<form ref={formRef} className="mt-5 space-y-4" onSubmit={submit} onChange={()=>{draftInProgress.current=true}}>
				<h3 className="font-semibold">{latest?.status==='RESUBMISSION_REQUIRED'?'Submit corrected evidence':'Start a verification submission'}</h3>
				<ol className="kyc-step-indicator" aria-label="Verification application progress">
					{['Identity details','Capture evidence','Review & submit'].map((label,index)=>{
						const active=index===step;
						const complete=index<step;
						return <li key={label} aria-current={active?'step':undefined} className={active?'is-active':complete?'is-complete':''}><span>{complete&&index<step?<CheckCircle2 size={14}/>:index+1}</span><small>{label}</small></li>;
					})}
				</ol>
				<fieldset hidden={step!==0} disabled={submitting} className="grid gap-3 sm:grid-cols-2">
					<legend className="mb-3 font-semibold" tabIndex={-1}>Identity information</legend>
					<label className="account-label">Document-issuing country<select className="input" value={country} onChange={event=>setCountry(event.target.value)}><option value="">Select a country</option>{countries.map(item=><option key={item.isoCode} value={item.isoCode}>{item.name}</option>)}</select></label>
					<label className="account-label">Document type<select className="input" value={documentType} onChange={event=>changeDocumentType(event.target.value as DocumentType)}>{requirements.map(item=><option key={item.type} value={item.type}>{item.label}</option>)}</select></label>
					<label className="account-label">Legal name<input className="input" autoComplete="name" maxLength={120} value={legalName} onChange={event=>setLegalName(event.target.value)} aria-invalid={Boolean(error&&step===0)}/></label>
					<label className="account-label">Date of birth<input className="input" type="date" autoComplete="bday" value={dateOfBirth} onChange={event=>setDateOfBirth(event.target.value)}/></label>
					{selectedRequirement?.expiryRequired&&<label className="account-label">Document expiry date<input className="input" type="date" value={documentExpiryDate} onChange={event=>setDocumentExpiryDate(event.target.value)}/></label>}
				</fieldset>
				<fieldset hidden={step!==1} disabled={submitting} className="space-y-4">
					<legend className="mb-3 font-semibold" tabIndex={-1}>Private identity evidence</legend>
					<div className="grid gap-3 sm:grid-cols-2">
						{([
							{target:'FRONT' as const,label:'Document front',file:front,preview:frontPreview,setFile:setFront},
							...(selectedRequirement?.sides.includes('BACK')?[{target:'BACK' as const,label:'Document back',file:back,preview:backPreview,setFile:setBack}]:[]),
						]).map(item=><div className="kyc-evidence-card" key={item.target}>
							<div className="kyc-evidence-heading"><span><ScanLine size={16}/>{item.label}</span><span className={item.file?'kyc-evidence-ready':''}>{item.file?'Captured':'Required'}</span></div>
							{item.file&&item.preview&&<div className="kyc-evidence-preview"><Image src={item.preview} alt={`${item.label} preview`} width={640} height={400} unoptimized/><span><CheckCircle2 size={14}/> Preview ready · {(item.file.size/1024).toFixed(0)} KB</span></div>}
							{renderCameraViewport(item.target)}
							<div className="kyc-evidence-actions">
								<button className="btn min-h-11 bg-white/10" type="button" disabled={cameraStarting} onClick={()=>void startCamera(item.target,'environment')}><Camera size={16}/>{item.file?'Retake with camera':'Open camera'}</button>
								<label className="kyc-file-picker">Choose image<input type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" capture="environment" onChange={event=>{selectEvidenceFile(event.target.files?.[0]||null,item.setFile);event.currentTarget.value='';if(captureTarget===item.target)closeCamera()}}/></label>
							</div>
						</div>)}
					</div>
					<div className="kyc-selfie-card">
						<div className="kyc-evidence-heading"><span><Camera size={16}/>Camera-captured selfie</span><span className={selfie?'kyc-evidence-ready':''}>{selfie?'Captured':'Required'}</span></div>
						{selfie&&selfiePreview&&<div className="kyc-selfie-preview"><Image src={selfiePreview} alt="Selfie preview" width={390} height={480} unoptimized/><div><b><CheckCircle2 size={14}/> Selfie preview ready</b><span>{selfie.name} · {(selfie.size/1024).toFixed(0)} KB</span></div><button className="text-link" type="button" onClick={()=>{setSelfie(null);void startCamera('SELFIE','user')}}><RefreshCw size={14}/> Retake</button></div>}
						{renderCameraViewport('SELFIE')}
						{!selfie&&captureTarget!=='SELFIE'&&<button className="btn mt-3 min-h-11 bg-white/10" type="button" disabled={cameraStarting} onClick={()=>void startCamera('SELFIE','user')}><Camera size={16}/>{cameraStarting?'Starting camera…':'Open selfie camera'}</button>}
					</div>
				</fieldset>
				<fieldset hidden={step!==2} disabled={submitting} className="space-y-4">
					<legend className="mb-3 font-semibold" tabIndex={-1}>Review before submission</legend>
					<dl className="grid gap-3 rounded-lg border border-white/10 p-4 text-sm sm:grid-cols-2">
						<div><dt className="text-xs muted">Document country and type</dt><dd>{countries.find(item=>item.isoCode===country)?.name||'Not selected'} · {selectedRequirement?.label||'Not selected'}</dd></div>
						<div><dt className="text-xs muted">Legal name</dt><dd>{legalName.trim()||'Not provided'}</dd></div>
						<div><dt className="text-xs muted">Date of birth</dt><dd>{dateOfBirth||'Not provided'}</dd></div>
						{selectedRequirement?.expiryRequired&&<div><dt className="text-xs muted">Document expiry</dt><dd>{documentExpiryDate||'Not provided'}</dd></div>}
						<div><dt className="text-xs muted">Document images</dt><dd>{front?.name||'Front image missing'}{selectedRequirement?.sides.includes('BACK')?` · ${back?.name||'Back image missing'}`:''}{frontPreview&&<Image className="kyc-review-thumbnail" src={frontPreview} alt="Document front review" width={220} height={145} unoptimized/>}{backPreview&&<Image className="kyc-review-thumbnail" src={backPreview} alt="Document back review" width={220} height={145} unoptimized/>}</dd></div>
						<div><dt className="text-xs muted">Selfie</dt><dd>{selfie?.name||'Selfie missing'}{selfiePreview&&<Image className="kyc-review-thumbnail is-selfie" src={selfiePreview} alt="Selfie review" width={96} height={110} unoptimized/>}</dd></div>
					</dl>
					<label className="flex items-start gap-2 text-sm leading-6 muted"><input className="mt-1" type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/><span>I consent to Aurevia securely storing this identity evidence and making it available to authorized reviewers for identity verification. See the <Link className="text-link" href="/privacy">privacy overview</Link>.</span></label>
				</fieldset>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<button className="btn min-h-11 bg-white/10" type="button" onClick={()=>{setError('');closeCamera();setStep(value=>Math.max(0,value-1))}} disabled={step===0||submitting}><ChevronLeft size={16}/>Back</button>
					<div className="flex flex-wrap items-center gap-3">
						{step<2?<button className="btn min-h-11 bg-gold px-4 text-black" type="button" onClick={()=>{if(validateCurrentStep()){closeCamera();setStep(value=>Math.min(2,value+1))}}}>Continue<ChevronRight size={16}/></button>:<button className="btn min-h-11 bg-gold px-4 text-black disabled:opacity-50" type="submit" disabled={!canSubmit}>{submitting?<><LoaderCircle size={16} className="animate-spin"/>Uploading evidence…</>:<><Upload size={16}/>Submit for verification</>}</button>}
					</div>
				</div>
				{draftStatus!=='idle'&&<p className={`text-xs ${draftStatus==='error'?'text-loss':'muted'}`} role={draftStatus==='error'?'alert':'status'}>{draftStatus==='saving'?'Saving encrypted draft…':draftStatus==='saved'?'Draft saved securely. You can resume after signing in again.':'Draft could not be saved. You can still submit, but unfinished changes may not be retained.'}</p>}
				{submitting&&<div className="space-y-1" role="status" aria-live="polite"><p className="text-xs muted">{uploadProgress===null?'Uploading and validating your files…':`Uploading evidence… ${uploadProgress}%`}</p>{uploadProgress!==null&&<progress className="w-full accent-amber-400" max={100} value={uploadProgress}>{uploadProgress}%</progress>}</div>}
			</form>}
			{verifications.length>1&&<details className="mt-5"><summary className="cursor-pointer text-sm gold">Previous verification cases ({verifications.length-1})</summary><ul className="mt-2 divide-y divide-white/10">{verifications.slice(1).map(item=><li className="py-2 text-sm" key={item.id}>{statusCopy[item.status]||item.status.replaceAll('_',' ')} · {item.submittedAt?new Date(item.submittedAt).toLocaleDateString():'Draft'}{item.decisionReason&&<span className="block text-xs muted">{item.decisionReason}</span>}</li>)}</ul></details>}
		</>}
		{latest?.status==='APPROVED'&&currentTier<3&&<p className="mt-4 text-sm"><Link className="text-link" href="/settings#profile">Update profile address</Link> · <Link className="text-link" href="/tier">Review Tier 3 requirements</Link></p>}
		{latest?.status==='APPROVED'&&currentTier>=3&&<p className="mt-4 text-sm text-profit"><CheckCircle2 className="mr-2 inline" size={16}/>Approved and upgraded to Tier 3.</p>}
	</section>;
}
