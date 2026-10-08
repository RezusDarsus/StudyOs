package com.studyos.planner;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties("studyos.planner")
public class PlannerProperties {
    private double examGapWeight = .40;
    private double reviewUrgencyWeight = .20;
    private double misconceptionWeight = .15;
    private double recentFailureWeight = .10;
    private double prerequisiteGapWeight = .10;
    private double deadlineWeight = .05;
    private double prerequisiteWeakThreshold = .60;
    private int maxPrerequisiteDepth = 3;
    private int maxInjectedPrerequisites = 3;
    private int maxTasks = 8;
    private int minimumTaskMinutes = 15;

    public double getExamGapWeight() { return examGapWeight; }
    public void setExamGapWeight(double value) { examGapWeight = value; }
    public double getReviewUrgencyWeight() { return reviewUrgencyWeight; }
    public void setReviewUrgencyWeight(double value) { reviewUrgencyWeight = value; }
    public double getMisconceptionWeight() { return misconceptionWeight; }
    public void setMisconceptionWeight(double value) { misconceptionWeight = value; }
    public double getRecentFailureWeight() { return recentFailureWeight; }
    public void setRecentFailureWeight(double value) { recentFailureWeight = value; }
    public double getPrerequisiteGapWeight() { return prerequisiteGapWeight; }
    public void setPrerequisiteGapWeight(double value) { prerequisiteGapWeight = value; }
    public double getDeadlineWeight() { return deadlineWeight; }
    public void setDeadlineWeight(double value) { deadlineWeight = value; }
    public double getPrerequisiteWeakThreshold() { return prerequisiteWeakThreshold; }
    public void setPrerequisiteWeakThreshold(double value) { prerequisiteWeakThreshold = value; }
    public int getMaxPrerequisiteDepth() { return maxPrerequisiteDepth; }
    public void setMaxPrerequisiteDepth(int value) { maxPrerequisiteDepth = value; }
    public int getMaxInjectedPrerequisites() { return maxInjectedPrerequisites; }
    public void setMaxInjectedPrerequisites(int value) { maxInjectedPrerequisites = value; }
    public int getMaxTasks() { return maxTasks; }
    public void setMaxTasks(int value) { maxTasks = value; }
    public int getMinimumTaskMinutes() { return minimumTaskMinutes; }
    public void setMinimumTaskMinutes(int value) { minimumTaskMinutes = value; }
}
