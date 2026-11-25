'use client';

import {useCallback,useEffect,useState} from 'react';
import {useSession} from 'next-auth/react';
import {ShieldCheck} from 'lucide-react';
import Link from 'next/link';
import Nav from '@/components/Nav';
import KycVerificationCenter from '@/components/KycVerificationCenter';
import {getKycProofFileValidationError} from '@/lib/kyc-client-validation';

type KycDocument={id:string;kind:string;filename:string;status:string;uploadedAt:string;reviewedAt:string|null;reviewNote:string|null};
type PageState={kycStatus:string;address:string;currentTier:number;documents:KycDocument[]};

export default function Kyc(){
	const {data:session,status:sessionStatus}=useSession();
	const [page,setPage]=useState<PageState>({kycStatus:'PENDING',address:'',currentTier:1,documents:[]});
	const [loading,setLoading]=useState(true);
	const [uploadingProof,setUploadingProof]=useState(false);
	const [proofFile,setProofFile]=useState<File|null>(null);
	const [message,setMessage]=useState('');
	const [error,setError]=useState('');

	const load=useCallback(async()=>{
		if(sessionStatus==='loading')return;
		if(sessionStatus!=='authenticated'){setLoading(false);return}
		if(session?.user?.accountMode!=='REAL'){setLoading(false);setError('');return}
		setLoading(true);
		try{
			const [kycResponse,profileResponse,tierResponse,documentsResponse]=await Promise.all([
				fetch('/api/kyc',{cache:'no-store'}),
				fetch('/api/profile',{cache:'no-store'}),
				fetch('/api/tier-requests',{cache:'no-store'}),
				fetch('/api/kyc/documents',{cache:'no-store'}),
			]);
			const [kyc,profile,tier,documents]=await Promise.all([kycResponse.json(),profileResponse.json(),tierResponse.json(),documentsResponse.json()]);
			if(!kycResponse.ok||!profileResponse.ok||!tierResponse.ok||!documentsResponse.ok)throw new Error(kyc.error||profile.error||tier.error||documents.error||'Unable to load verification status.');
			setPage({
				kycStatus:profile.kycStatus||'PENDING',
				address:profile.address||'',
				currentTier:typeof tier.currentTier==='number'?tier.currentTier:1,
				documents,
			});
			setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load verification status.')}
		finally{setLoading(false)}
	},[session?.user?.accountMode,sessionStatus]);

	useEffect(()=>{void load()},[load]);
	const refreshTier=useCallback(()=>void load(),[load]);

	async function uploadProofOfAddress(){
		if(!proofFile||uploadingProof)return;
		setUploadingProof(true);setError('');setMessage('');
		try{
			const form=new FormData();
			form.append('file',proofFile);
			form.append('kind','PROOF_OF_ADDRESS');
			const response=await fetch('/api/kyc/documents',{method:'POST',body:form});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to upload proof of address.');
			setProofFile(null);
			setMessage('Your proof of address was submitted for administrator review.');
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to upload proof of address.')}
		finally{setUploadingProof(false)}
	}

	const isVerified=page.kycStatus==='APPROVED';
	const statusLabel=page.kycStatus.replaceAll('_',' ');
	const isRealAccount=session?.user?.accountMode==='REAL';
	const proofDocuments=page.documents.filter(document=>document.kind==='PROOF_OF_ADDRESS');
	const proofAlreadySubmitted=proofDocuments.some(document=>!['REJECTED','RESUBMISSION_REQUIRED'].includes(document.status));
	const canUploadProof=page.currentTier>=2&&page.kycStatus==='APPROVED'&&Boolean(page.address.trim())&&!proofAlreadySubmitted;

	return <><Nav/><main className="account-page">
	<header className="account-heading"><div><span className="account-kicker">Account verification</span><h1>Identity verification</h1></div>{isVerified?<span className="verified-badge"><ShieldCheck size={14} aria-hidden="true"/> Verified</span>:<span className="status-pill">{loading?'Loading status':statusLabel}</span>}</header>
		{sessionStatus==='authenticated'&&!isRealAccount?<section className="account-panel card p-5" role="status"><h2 className="font-semibold">REAL mode required</h2></section>:<>
			{error&&<div className="account-callout mb-4" role="alert"><span>{error}</span><button type="button" className="text-link" disabled={loading||uploadingProof} onClick={()=>void load()}>Retry</button></div>}
			{message&&<p className="mb-4 text-sm text-profit" role="status">{message}</p>}
			<KycVerificationCenter currentTier={page.currentTier} onUpdated={refreshTier}/>
			{page.currentTier>=2&&page.kycStatus==='APPROVED'&&<section className="account-panel card mt-4 p-5">
				<h2 className="text-lg font-semibold">Tier 3 proof of address</h2>
				{!page.address.trim()&&<p className="mt-3 text-sm muted"><Link className="text-link" href="/settings#profile">Add residential address</Link></p>}
				{proofDocuments.map(document=><div className="mt-3 rounded-lg border border-white/10 p-3 text-sm" key={document.id}><p>{document.filename} · {document.status.replaceAll('_',' ')}</p>{document.reviewNote&&<p className="mt-1 muted">{document.reviewNote}</p>}</div>)}
				{canUploadProof&&<div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]"><label className="account-label">Proof-of-address file<input className="input" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" disabled={uploadingProof} onChange={event=>{const input=event.currentTarget;const file=input.files?.[0]||null;input.value='';if(!file)return;const validationError=getKycProofFileValidationError(file);if(validationError){setError(validationError);return}setProofFile(file);setError('')}}/>{proofFile&&<span className="text-xs muted" role="status">{proofFile.name} · {(proofFile.size/1024).toFixed(0)} KB</span>}</label><button className="btn bg-gold text-black self-end" type="button" disabled={!proofFile||uploadingProof} onClick={()=>void uploadProofOfAddress()}>{uploadingProof?'Uploading…':'Upload proof of address'}</button></div>}
			</section>}
		</>}
	</main></>;
}
