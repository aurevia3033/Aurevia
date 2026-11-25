type FundingType='DEPOSIT'|'WITHDRAWAL';
type FundingStatusNotice={
	tone:'success'|'declined'|'pending'|'attention'|'neutral';
	title:string;
	description:string;
	emoji?:string;
	processing?:boolean;
};

export function getFundingStatusNotice(type:FundingType,status:string):FundingStatusNotice|null{
	if(status==='COMPLETED'||(type==='DEPOSIT'&&status==='APPROVED')){
		return type==='DEPOSIT'
			?{tone:'success',title:'Congratulations! Your deposit is confirmed.',description:'An administrator approved your request and recorded the credit in your internal Aurevia ledger.',emoji:'😊'}
			:{tone:'success',title:'Congratulations! Your withdrawal payout is confirmed.',description:'An administrator recorded the completed payout.',emoji:'😊'};
	}
	if(status==='PROCESSING'){
		return type==='WITHDRAWAL'
			?{tone:'pending',title:'Your withdrawal payout is processing.',description:'The payout is not confirmed yet. We will update this status when an administrator records the outcome.',processing:true}
			:{tone:'pending',title:'Your deposit request is processing.',description:'Your request is being reviewed. The ledger has not been credited yet.',processing:true};
	}
	if(status==='APPROVED'&&type==='WITHDRAWAL'){
		return {tone:'pending',title:'Your withdrawal is approved and awaiting payout.',description:'The requested amount remains reserved. Approval is not confirmation that payment has been sent.'};
	}
	if(status==='PENDING'||status==='PENDING_REVIEW'){
		return {tone:'pending',title:`Your ${type.toLowerCase()} request is pending review.`,description:'An administrator must review the request before its outcome is confirmed.'};
	}
	if(status==='REJECTED'){
		return type==='WITHDRAWAL'
			?{tone:'declined',title:'Your withdrawal request was declined.',description:'Review the administrator note and wallet history for the final balance details.'}
			:{tone:'declined',title:'Your deposit request was declined.',description:'No deposit credit was recorded in the ledger. Review the administrator note for details.'};
	}
	if(status==='FAILED'){
		return type==='WITHDRAWAL'
			?{tone:'declined',title:'Your withdrawal payout failed.',description:'Any reserved funds were released or refunded to your wallet. Check your ledger history for the recorded adjustment.'}
			:{tone:'declined',title:'Your deposit request failed.',description:'No deposit credit was recorded in the ledger.'};
	}
	if(status==='CANCELLED'||status==='REVERSED'){
		return {tone:'neutral',title:`Your ${type.toLowerCase()} request was ${status.toLowerCase()}.`,description:'Check your wallet history for the latest recorded balance and request details.'};
	}
	return null;
}
