export const aureviaMotion={
	duration:{fast:.16,base:.28,slow:.52},
	ease:[0.22,1,0.36,1] as [number,number,number,number],
	card:{initial:{opacity:0,y:10,scale:.985},animate:{opacity:1,y:0,scale:1}},
	modal:{initial:{opacity:0,y:14,scale:.98},animate:{opacity:1,y:0,scale:1},exit:{opacity:0,y:8,scale:.985}},
	notification:{initial:{opacity:0,x:24},animate:{opacity:1,x:0},exit:{opacity:0,x:24}},
} as const;
