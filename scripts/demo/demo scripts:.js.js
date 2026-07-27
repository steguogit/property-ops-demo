demo scripts: 

const now = new Date();                                                                                                                                                 0% used                                 
     db.chunks.insertOne({                                                                                                                                                   $0.00 spent                             
       _id: "ROSTER-LIVE-" + now.getTime() + "#0",                                                                                                                                                                   
       docId: "ROSTER-LIVE-" + now.getTime(),                                                                                                                                LSP                                     
       docType: "duty_roster",                                                                                                                                               LSPs are disabled                       
       title: "Duty Roster Update - Peter Chan @ Harbour East [NEW - inserted " + now.toISOString().slice(0, 16).replace("T", " ") + "]",                                                                            
       propertyName: "Harbour East",                                                                                                                                                                                 
       propertyAliases: ["duty roster", "on-call", "contacts"],                                                                                                                                                      
       segment: "master_data",                                                                                                                                                                                       
       region: "Hong Kong",                                                                                                                                                                                          
       language: ["en", "zh"],                                                                                                                                                                                       
       audience: ["internal_staff"],                                                                                                                                                                                 
       tags: ["roster", "contacts", "duty_manager", "escalation", "live_demo"],                                                                                                                                      
       exactTerms: ["Peter Chan", "Chan Tai Man", "P. T. Chan", "陳大文", "Harbour East", "duty manager", "after-hours"],                                                                                            
       extractedFields: { person: "Peter Chan", assignedProperty: "Harbour East", role: "Night Duty Manager", source: "live_demo" },                                                                                 
       insertedAt: now,                                                                                                                                                                                              
       insertedDate: now.toISOString().slice(0, 10),                                                                                                                                                                 
       updatedAt: now.toISOString().slice(0, 10),                                                                                                                                                                    
       chunkText: "[NEWLY INSERTED " + now.toISOString().slice(0, 10) + "] DUTY ROSTER UPDATE (Hong Kong). NEW ASSIGNMENT effective " + now.toISOString().slice(0, 10) +                                             
     ": Peter Chan (also recorded as Chan Tai Man, P. T. Chan, 陳大文 - SAME person) is now the Night Duty Manager for Harbour East, covering the overnight 23:00-07:00                                              
     shift, on-call 24/7. Peter Chan handles after-hours operations, incident escalation, and overnight contractor liaison for Harbour East. For Harbour East after-                                                 
     hours, contact Peter Chan first (response within 30 minutes), then Group Operations Control Room.",                                                                                                             
       sourceText: "Duty roster update: Peter Chan (陳大文) is now Night Duty Manager for Harbour East, overnight shift, on-call 24/7.",                                                                             
       chunkIndex: 0                                                                                                                                                                                                 
     })



     use property_ops_demo                                                                                                                                                                                           
                                                                                                                                                                                                                     
     const now = new Date();                                                                                                                                                                                         
     db.chunks.insertOne({                                                                                                                                                                                           
       _id: "PROP-LIVE-" + now.getTime() + "#0",                                                                                                                                                                     
       docId: "PROP-LIVE-" + now.getTime(),                                                                                                                                                                          
       docType: "property_profile",                                                                                                                                                                                  
       title: "Property Profile - Harbour East [NEW " + now.toISOString().slice(0, 10) + "]",                                                                                                                        
       propertyName: "Harbour East",                                                                                                                                                                                 
       propertyAliases: ["TQ", "啟匯", "Kwun Tong Quayside"],                                                                                                                                                        
       segment: "office_tower",                                                                                                                                                                                      
       region: "Kowloon East",                                                                                                                                                                                       
       language: ["en", "zh"],                                                                                                                                                                                       
       audience: ["internal_staff"],                                                                                                                                                                                 
       tags: ["property", "onboarding", "operations", "live_demo"],                                                                                                                                                  
       exactTerms: ["Harbour East", "啟匯", "Peter Chan"],                                                                                                                                                           
       extractedFields: { dutyManager: "Peter Chan", source: "live_demo" },                                                                                                                                          
       insertedAt: now,                                                                                                                                                                                              
       insertedDate: now.toISOString().slice(0, 10),                                                                                                                                                                 
       updatedAt: now.toISOString().slice(0, 10),                                                                                                                                                                    
       chunkText: "[NEWLY INSERTED " + now.toISOString().slice(0, 10) + "] PROPERTY PROFILE - Harbour East office tower (啟匯 / Kwun Tong Quayside). Segment:                                                        
     office_tower. Region: Kowloon East. Harbour East is a newly onboarded office tower in Kowloon East. Duty Manager: Peter Chan, on-call 24/7 for after-hours                                                      
     operations and incident escalation. Building services include chilled-water HVAC, loading-bay access control, and overnight contractor fitting-out support.",                                                   
       sourceText: "PROPERTY PROFILE - Harbour East office tower (啟匯 / Kwun Tong Quayside). Newly onboarded office tower in Kowloon East. Duty Manager Peter Chan, on-                                             
     call 24/7.",                                                                                                                                                                                                    
       chunkIndex: 0                                                                                                                                                                                                 
     })            