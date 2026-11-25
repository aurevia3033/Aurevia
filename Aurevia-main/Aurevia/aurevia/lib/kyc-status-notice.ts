export type KycVerificationNotice={
	tone:'success'|'declined'|'pending'|'attention'|'neutral';
	title:string;
	description:string;
	emoji?:string;
	processing?:boolean;
};

const notices:Record<string,KycVerificationNotice>={
	APPROVED:{tone:'success',title:'Congratulations! Your identity verification passed.',description:'Your verification is confirmed and approved.',emoji:'😊'},
	REJECTED:{tone:'declined',title:'Your identity verification was declined.',description:'Review the decision notes below. You may submit a new application when you are ready.'},
	PROCESSING:{tone:'pending',title:'Your verification is processing.',description:'We are processing your submission. Its status will update here when it changes.',processing:true},
	SUBMITTED:{tone:'pending',title:'Your verification is pending review.',description:'Your submission was received and is waiting for review.'},
	PENDING_REVIEW:{tone:'pending',title:'Your verification is pending review.',description:'Your submission is waiting for an authorized administrator to review it.'},
	NEEDS_REVIEW:{tone:'pending',title:'Your verification is still under review.',description:'Your case needs additional review. We will update you when a decision is recorded.'},
	RESUBMISSION_REQUIRED:{tone:'attention',title:'Updates are needed to continue verification.',description:'Review the administrator’s notes below, then submit corrected evidence.'},
	CANCELLED:{tone:'neutral',title:'This verification case is closed.',description:'No decision was recorded for this case. You can start a new submission if you still need verification.'},
	EXPIRED:{tone:'neutral',title:'This verification case has expired.',description:'Contact support if you still need help completing verification.'},
};

export function getKycVerificationNotice(status:string):KycVerificationNotice|null{
	return notices[status]??null;
}
